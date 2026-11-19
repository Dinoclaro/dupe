package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5"
	"golang.org/x/crypto/bcrypt"
)

type contextKey string

const userContextKey contextKey = "authenticated_user"

const tokenTTL = 90 * 24 * time.Hour

type AuthClaims struct {
	UserID   int    `json:"uid"`
	Username string `json:"sub"`
	jwt.RegisteredClaims
}

type User struct {
	ID        int       `json:"id"`
	Username  string    `json:"username"`
	ColorHex  string    `json:"color_hex"`
	CreatedAt time.Time `json:"created_at"`
}

func hashPassword(password string) (string, error) {
	trimmed := strings.TrimSpace(password)
	if len(trimmed) < 8 {
		return "", fmt.Errorf("password must be at least 8 characters")
	}
	hashed, err := bcrypt.GenerateFromPassword([]byte(trimmed), bcrypt.DefaultCost)
	if err != nil {
		return "", fmt.Errorf("hash password: %w", err)
	}
	return string(hashed), nil
}

func verifyPassword(hash, password string) error {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(password))
}

func issueToken(secret []byte, userID int, username string, now time.Time) (string, error) {
	if len(secret) < 16 {
		return "", fmt.Errorf("JWT secret must be at least 16 bytes")
	}
	claims := AuthClaims{
		UserID:   userID,
		Username: username,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   username,
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(tokenTTL)),
		},
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString(secret)
}

func parseToken(secret []byte, tokenString string) (*AuthClaims, error) {
	claims := &AuthClaims{}
	token, err := jwt.ParseWithClaims(tokenString, claims, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
		}
		return secret, nil
	})
	if err != nil || !token.Valid {
		return nil, fmt.Errorf("invalid token: %w", err)
	}
	return claims, nil
}

func createOrUpdateUser(ctx context.Context, db pgxQuerier, username, password, colorHex string) error {
	cleanUser := strings.TrimSpace(username)
	if cleanUser == "" {
		return fmt.Errorf("username is required")
	}
	hash, err := hashPassword(password)
	if err != nil {
		return err
	}
	if colorHex == "" {
		colorHex = "#FFEB3B"
	}
	const query = `
		INSERT INTO users (username, password_hash, color_hex)
		VALUES ($1, $2, $3)
		ON CONFLICT (username)
		DO UPDATE SET password_hash = EXCLUDED.password_hash, color_hex = EXCLUDED.color_hex
	`
	_, err = db.Exec(ctx, query, cleanUser, hash, colorHex)
	if err != nil {
		return fmt.Errorf("upsert user %q: %w", cleanUser, err)
	}
	return nil
}

func (s *Server) requireAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rawToken := extractBearerToken(r)
		if rawToken == "" && s.mode == "local" {
			claims := &AuthClaims{
				UserID:   1,
				Username: "local",
			}
			ctx := context.WithValue(r.Context(), userContextKey, claims)
			next(w, r.WithContext(ctx))
			return
		}
		if rawToken == "" {
			writeError(w, http.StatusUnauthorized, "missing bearer token")
			return
		}
		claims, err := parseToken(s.jwtSecret, rawToken)
		if err != nil {
			if s.mode == "local" {
				localClaims := &AuthClaims{UserID: 1, Username: "local"}
				ctx := context.WithValue(r.Context(), userContextKey, localClaims)
				next(w, r.WithContext(ctx))
				return
			}
			writeError(w, http.StatusUnauthorized, "invalid or expired token")
			return
		}
		ctx := context.WithValue(r.Context(), userContextKey, claims)
		next(w, r.WithContext(ctx))
	}
}

func extractBearerToken(r *http.Request) string {
	authHeader := strings.TrimSpace(r.Header.Get("Authorization"))
	if strings.HasPrefix(strings.ToLower(authHeader), "bearer ") {
		return strings.TrimSpace(authHeader[7:])
	}
	return strings.TrimSpace(r.URL.Query().Get("token"))
}

func currentUser(r *http.Request) (*AuthClaims, bool) {
	claims, ok := r.Context().Value(userContextKey).(*AuthClaims)
	return claims, ok && claims != nil
}

type loginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type loginResponse struct {
	Token string `json:"token"`
	User  User   `json:"user"`
}

type loginAttemptEntry struct {
	failures    int
	firstFailed time.Time
	lockedUntil time.Time
}

var (
	loginAttemptsMu  sync.Mutex
	loginAttemptsMap = make(map[string]loginAttemptEntry)
)

func clientIPFromRequest(r *http.Request) string {
	if cfIP := strings.TrimSpace(r.Header.Get("Cf-Connecting-Ip")); cfIP != "" {
		return cfIP
	}
	if xff := strings.TrimSpace(r.Header.Get("X-Forwarded-For")); xff != "" {
		parts := strings.Split(xff, ",")
		return strings.TrimSpace(parts[0])
	}
	host, _, err := net.SplitHostPort(strings.TrimSpace(r.RemoteAddr))
	if err == nil && host != "" {
		return host
	}
	return r.RemoteAddr
}

func checkLoginRateLimit(ip string, now time.Time) bool {
	loginAttemptsMu.Lock()
	defer loginAttemptsMu.Unlock()
	entry, ok := loginAttemptsMap[ip]
	if !ok {
		return true
	}
	if now.Before(entry.lockedUntil) {
		return false
	}
	if now.Sub(entry.firstFailed) > 5*time.Minute {
		delete(loginAttemptsMap, ip)
	}
	return true
}

func recordLoginFailure(ip string, now time.Time) {
	loginAttemptsMu.Lock()
	defer loginAttemptsMu.Unlock()
	entry, ok := loginAttemptsMap[ip]
	if !ok || now.Sub(entry.firstFailed) > 5*time.Minute {
		entry = loginAttemptEntry{failures: 1, firstFailed: now}
	} else {
		entry.failures++
	}
	if entry.failures >= 8 {
		entry.lockedUntil = now.Add(1 * time.Minute)
	}
	loginAttemptsMap[ip] = entry
}

func clearLoginFailures(ip string) {
	loginAttemptsMu.Lock()
	defer loginAttemptsMu.Unlock()
	delete(loginAttemptsMap, ip)
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	clientIP := clientIPFromRequest(r)
	now := time.Now().UTC()
	if !checkLoginRateLimit(clientIP, now) {
		writeError(w, http.StatusTooManyRequests, "too many failed login attempts; try again in 1 minute")
		return
	}

	var req loginRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	username := strings.TrimSpace(req.Username)
	if username == "" || req.Password == "" {
		writeError(w, http.StatusBadRequest, "username and password are required")
		return
	}

	var user User
	var passwordHash string
	const query = `
		SELECT id, username, password_hash, color_hex, created_at
		FROM users
		WHERE username = $1
	`
	err := s.db.QueryRow(r.Context(), query, username).Scan(
		&user.ID,
		&user.Username,
		&passwordHash,
		&user.ColorHex,
		&user.CreatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		recordLoginFailure(clientIP, now)
		writeError(w, http.StatusUnauthorized, "invalid credentials")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database query failed")
		return
	}

	if err := verifyPassword(passwordHash, req.Password); err != nil {
		recordLoginFailure(clientIP, now)
		writeError(w, http.StatusUnauthorized, "invalid credentials")
		return
	}
	clearLoginFailures(clientIP)

	token, err := issueToken(s.jwtSecret, user.ID, user.Username, now)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to sign token")
		return
	}

	writeJSON(w, http.StatusOK, loginResponse{
		Token: token,
		User:  user,
	})
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	claims, ok := currentUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	var user User
	const query = `
		SELECT id, username, color_hex, created_at
		FROM users
		WHERE id = $1
	`
	err := s.db.QueryRow(r.Context(), query, claims.UserID).Scan(
		&user.ID,
		&user.Username,
		&user.ColorHex,
		&user.CreatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		if s.mode == "local" {
			writeJSON(w, http.StatusOK, User{
				ID:        1,
				Username:  "local",
				ColorHex:  "#FFEB3B",
				CreatedAt: time.Now().UTC(),
			})
			return
		}
		writeError(w, http.StatusUnauthorized, "user not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database query failed")
		return
	}

	writeJSON(w, http.StatusOK, user)
}

type changePasswordRequest struct {
	NewPassword string `json:"new_password"`
}

func (s *Server) handleChangePassword(w http.ResponseWriter, r *http.Request) {
	claims, ok := currentUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	var req changePasswordRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if len(req.NewPassword) < 8 {
		writeError(w, http.StatusBadRequest, "password must be at least 8 characters")
		return
	}
	hash, err := hashPassword(req.NewPassword)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to hash password")
		return
	}
	if _, err := s.db.Exec(r.Context(), "UPDATE users SET password_hash = $1 WHERE id = $2", hash, claims.UserID); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update password")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "updated"})
}

