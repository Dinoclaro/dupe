package main

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	"github.com/creack/pty"
	"github.com/gorilla/websocket"
)

var terminalUpgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	CheckOrigin: func(_ *http.Request) bool {
		return true
	},
}

type terminalClientMessage struct {
	Type string `json:"type"`
	Data string `json:"data"`
	Cols uint16 `json:"cols"`
	Rows uint16 `json:"rows"`
}

func resolveShellBinary() string {
	if sh := strings.TrimSpace(os.Getenv("SHELL")); sh != "" {
		if _, err := os.Stat(sh); err == nil {
			return sh
		}
	}
	for _, candidate := range []string{"/bin/bash", "/usr/bin/bash", "/bin/sh"} {
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
	}
	return "sh"
}

func (s *Server) resolveTerminalWorkDir(r *http.Request, userID int) string {
	repoID := strings.TrimSpace(r.URL.Query().Get("repo_id"))
	if isValidUUID(repoID) {
		if _, absRepoPath, err := s.lookupOwnedRepo(r.Context(), repoID, userID); err == nil {
			if info, statErr := os.Stat(absRepoPath); statErr == nil && info.IsDir() {
				return absRepoPath
			}
		}
	}
	if absRoot, err := filepath.Abs(filepath.Join(s.storageDir, "..")); err == nil {
		if info, statErr := os.Stat(absRoot); statErr == nil && info.IsDir() {
			return absRoot
		}
	}
	return "."
}

func (s *Server) handleTerminalWS(w http.ResponseWriter, r *http.Request) {
	claims, ok := currentUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	cols := uint16(100)
	rows := uint16(30)
	if c, err := strconv.Atoi(r.URL.Query().Get("cols")); err == nil && c > 10 && c < 500 {
		cols = uint16(c)
	}
	if rw, err := strconv.Atoi(r.URL.Query().Get("rows")); err == nil && rw > 5 && rw < 300 {
		rows = uint16(rw)
	}

	conn, err := terminalUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer func() { _ = conn.Close() }()

	shellBin := resolveShellBinary()
	workDir := s.resolveTerminalWorkDir(r, claims.UserID)

	cmd := exec.CommandContext(r.Context(), shellBin, "-i")
	cmd.Dir = workDir

	currentPath := os.Getenv("PATH")
	if !strings.Contains(currentPath, "/home/linuxbrew/.linuxbrew/bin") {
		currentPath = "/home/linuxbrew/.linuxbrew/bin:" + currentPath
	}
	cmd.Env = append(
		os.Environ(),
		"PATH="+currentPath,
		"TERM=xterm-256color",
		"COLORTERM=truecolor",
	)

	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{
		Cols: cols,
		Rows: rows,
	})
	if err != nil {
		_ = conn.WriteMessage(websocket.TextMessage, []byte("\r\n[Failed to start PTY: "+err.Error()+"]\r\n"))
		return
	}

	var closeOnce sync.Once
	cleanup := func() {
		closeOnce.Do(func() {
			_ = ptmx.Close()
			if cmd.Process != nil {
				_ = cmd.Process.Kill()
			}
			_ = cmd.Wait()
		})
	}
	defer cleanup()

	var writeMu sync.Mutex
	sendWS := func(msgType int, data []byte) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		return conn.WriteMessage(msgType, data)
	}

	// Stream PTY stdout/stderr to WebSocket
	go func() {
		buf := make([]byte, 4096)
		for {
			n, readErr := ptmx.Read(buf)
			if n > 0 {
				if err := sendWS(websocket.BinaryMessage, buf[:n]); err != nil {
					cleanup()
					return
				}
			}
			if readErr != nil {
				if readErr != io.EOF {
					_ = sendWS(websocket.TextMessage, []byte("\r\n[Terminal session ended]\r\n"))
				}
				_ = conn.Close()
				return
			}
		}
	}()

	// Stream WebSocket input and resize commands to PTY
	for {
		msgType, payload, readErr := conn.ReadMessage()
		if readErr != nil {
			return
		}
		if msgType == websocket.TextMessage && len(payload) > 0 && payload[0] == '{' {
			var ctrl terminalClientMessage
			if json.Unmarshal(payload, &ctrl) == nil && ctrl.Type != "" {
				switch ctrl.Type {
				case "resize":
					if ctrl.Cols > 0 && ctrl.Rows > 0 {
						_ = pty.Setsize(ptmx, &pty.Winsize{
							Cols: ctrl.Cols,
							Rows: ctrl.Rows,
						})
					}
				case "input":
					if ctrl.Data != "" {
						_, _ = ptmx.Write([]byte(ctrl.Data))
					}
				}
				continue
			}
		}
		_, _ = ptmx.Write(payload)
	}
}
