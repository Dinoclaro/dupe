package main

import (
	"context"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	curatedBrainMaxLines = 150
	curatedBrainMaxBytes = 8 * 1024
)

var (
	wikiLinkPattern   = regexp.MustCompile(`(!?)\[\[([^\]\n]+)\]\]`)
	inlineTagPattern  = regexp.MustCompile(`(?:^|[\s,(])#([a-zA-Z][a-zA-Z0-9_/-]*)`)
	latexCitePattern  = regexp.MustCompile(`\\cite[a-zA-Z*]*\{([^}]+)\}`)
	slugSanitizeRegex = regexp.MustCompile(`[^a-zA-Z0-9_-]+`)
)

type BrainNode struct {
	ID          string   `json:"id"`
	Label       string   `json:"label"`
	Kind        string   `json:"kind"` // "moc" | "concept" | "note" | "artifact" | "blackboard" | "paper" | "tex" | "code" | "ghost"
	Path        string   `json:"path"`
	Tags        []string `json:"tags,omitempty"`
	Aliases     []string `json:"aliases,omitempty"`
	Status      string   `json:"status,omitempty"`
	Degree      int      `json:"degree"`
	Backlinks   int      `json:"backlinks"`
	Lines       int      `json:"lines,omitempty"`
	Bytes       int      `json:"bytes,omitempty"`
	Bloated     bool     `json:"bloated,omitempty"`
	BloatReason string   `json:"bloat_reason,omitempty"`
	Snippet     string   `json:"snippet,omitempty"`
}

type BrainEdge struct {
	Source  string `json:"source"`
	Target  string `json:"target"`
	Kind    string `json:"kind"` // "wikilink" | "cite" | "provenance"
	Line    int    `json:"line,omitempty"`
	Preview string `json:"preview,omitempty"`
}

type BrainHubSummary struct {
	ID        string `json:"id"`
	Label     string `json:"label"`
	Path      string `json:"path"`
	Backlinks int    `json:"backlinks"`
	Degree    int    `json:"degree"`
}

type BrainGraphSummary struct {
	TotalNodes       int               `json:"total_nodes"`
	TotalEdges       int               `json:"total_edges"`
	CuratedNoteCount int               `json:"curated_note_count"`
	ArtifactCount    int               `json:"artifact_count"`
	BlackboardCount  int               `json:"blackboard_count"`
	OrphanCount      int               `json:"orphan_count"`
	GhostCount       int               `json:"ghost_count"`
	BloatedCount     int               `json:"bloated_count"`
	TopHubs          []BrainHubSummary `json:"top_hubs,omitempty"`
	Orphans          []string          `json:"orphans,omitempty"`
	Ghosts           []string          `json:"ghosts,omitempty"`
	BloatedNotes     []string          `json:"bloated_notes,omitempty"`
	BlackboardTopics []string          `json:"blackboard_topics,omitempty"`
}

type BrainGraph struct {
	Nodes   []BrainNode       `json:"nodes"`
	Edges   []BrainEdge       `json:"edges"`
	Summary BrainGraphSummary `json:"summary"`
}

type BrainGraphOptions struct {
	IncludeAgentBrain bool
	Focus             string
	Depth             int
}

type parsedFrontmatter struct {
	Type    string
	Status  string
	Tags    []string
	Aliases []string
}

func parseMarkdownFrontmatter(content string) (parsedFrontmatter, string) {
	norm := strings.ReplaceAll(content, "\r\n", "\n")
	if !strings.HasPrefix(norm, "---\n") {
		return parsedFrontmatter{}, norm
	}
	rest := norm[4:]
	endIdx := strings.Index(rest, "\n---\n")
	endLen := 5
	if endIdx < 0 {
		if strings.HasSuffix(rest, "\n---") {
			endIdx = len(rest) - 4
			endLen = 4
		} else {
			return parsedFrontmatter{}, norm
		}
	}
	header := rest[:endIdx]
	body := rest[endIdx+endLen:]

	var fm parsedFrontmatter
	var currentListKey string
	for _, rawLine := range strings.Split(header, "\n") {
		trimmed := strings.TrimSpace(rawLine)
		if trimmed == "" {
			continue
		}
		if strings.HasPrefix(trimmed, "- ") && (currentListKey == "tags" || currentListKey == "aliases") {
			item := strings.Trim(strings.TrimSpace(strings.TrimPrefix(trimmed, "- ")), `"'`)
			if item != "" {
				if currentListKey == "tags" {
					fm.Tags = append(fm.Tags, strings.TrimPrefix(item, "#"))
				} else {
					fm.Aliases = append(fm.Aliases, item)
				}
			}
			continue
		}
		currentListKey = ""
		colonIdx := strings.IndexByte(trimmed, ':')
		if colonIdx <= 0 {
			continue
		}
		key := strings.ToLower(strings.TrimSpace(trimmed[:colonIdx]))
		val := strings.TrimSpace(trimmed[colonIdx+1:])
		switch key {
		case "type":
			fm.Type = strings.ToLower(strings.Trim(val, `"'`))
		case "status":
			fm.Status = strings.Trim(val, `"'`)
		case "tags", "aliases":
			if val == "" {
				currentListKey = key
				continue
			}
			val = strings.TrimPrefix(strings.TrimSuffix(val, "]"), "[")
			for _, part := range strings.Split(val, ",") {
				item := strings.Trim(strings.TrimSpace(part), `"'`)
				if item == "" {
					continue
				}
				if key == "tags" {
					fm.Tags = append(fm.Tags, strings.TrimPrefix(item, "#"))
				} else {
					fm.Aliases = append(fm.Aliases, item)
				}
			}
		}
	}
	return fm, body
}

func extractNoteTags(content string, fm parsedFrontmatter) []string {
	seen := make(map[string]bool)
	var out []string
	add := func(t string) {
		clean := strings.TrimPrefix(strings.TrimSpace(t), "#")
		if clean == "" || seen[clean] {
			return
		}
		seen[clean] = true
		out = append(out, clean)
	}
	for _, t := range fm.Tags {
		add(t)
	}
	inFence := false
	for _, line := range strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "```") {
			inFence = !inFence
			continue
		}
		if inFence {
			continue
		}
		for _, m := range inlineTagPattern.FindAllStringSubmatch(line, -1) {
			if len(m) >= 2 {
				add(m[1])
			}
		}
	}
	return out
}

func extractWikiTargets(content string) (noteTargets []string, paperKeys []string) {
	inFence := false
	for _, line := range strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "```") {
			inFence = !inFence
			continue
		}
		if inFence {
			continue
		}
		for _, m := range wikiLinkPattern.FindAllStringSubmatch(line, -1) {
			if len(m) < 3 {
				continue
			}
			inner := strings.TrimSpace(m[2])
			if pipeIdx := strings.IndexByte(inner, '|'); pipeIdx >= 0 {
				inner = strings.TrimSpace(inner[:pipeIdx])
			}
			if inner == "" {
				continue
			}
			if strings.HasPrefix(strings.ToLower(inner), "paper:") {
				key := strings.TrimSpace(inner[len("paper:"):])
				if key != "" {
					paperKeys = append(paperKeys, key)
				}
				continue
			}
			if hashIdx := strings.IndexByte(inner, '#'); hashIdx >= 0 {
				inner = strings.TrimSpace(inner[:hashIdx])
			}
			if inner != "" {
				noteTargets = append(noteTargets, inner)
			}
		}
	}
	return noteTargets, paperKeys
}

func sanitizeBrainSlug(raw string) string {
	clean := strings.ToLower(strings.TrimSpace(raw))
	clean = strings.ReplaceAll(clean, " ", "-")
	clean = slugSanitizeRegex.ReplaceAllString(clean, "-")
	clean = strings.Trim(clean, "-_")
	if clean == "" {
		return "topic"
	}
	return clean
}

func isUtilityHumanNote(relPath string) bool {
	base := strings.ToLower(filepath.Base(relPath))
	switch base {
	case "comments.md", "changes.md", "paperchanges.md", "agents.user.md":
		return true
	}
	return strings.HasPrefix(filepath.ToSlash(relPath), "notes/daily/")
}

func extractFirstSnippet(body string) string {
	for _, line := range strings.Split(strings.ReplaceAll(body, "\r\n", "\n"), "\n") {
		trim := strings.TrimSpace(line)
		if trim == "" || strings.HasPrefix(trim, "#") || strings.HasPrefix(trim, "```") {
			continue
		}
		if len(trim) > 160 {
			return trim[:160] + "..."
		}
		return trim
	}
	return ""
}

func buildProjectBrainGraph(ctx context.Context, projectDir string, refs []RefIndexEntry, opts BrainGraphOptions) BrainGraph {
	nodeMap := make(map[string]*BrainNode)
	var edges []BrainEdge
	edgeSeen := make(map[string]bool)

	addEdge := func(src, dst, kind string, line int, preview string) {
		if src == "" || dst == "" || src == dst {
			return
		}
		key := src + "->" + dst + ":" + kind
		if edgeSeen[key] {
			return
		}
		edgeSeen[key] = true
		edges = append(edges, BrainEdge{
			Source:  src,
			Target:  dst,
			Kind:    kind,
			Line:    line,
			Preview: preview,
		})
	}

	type parsedNote struct {
		nodeID      string
		relPath     string
		slug        string
		title       string
		aliases     []string
		noteTargets []string
		paperKeys   []string
	}
	var parsedNotes []parsedNote
	lookup := make(map[string]string) // normalized slug / title / alias -> nodeID

	scanMarkdownRoot := func(rootDir, defaultKind string) {
		if _, err := os.Stat(rootDir); err != nil {
			return
		}
		_ = filepath.WalkDir(rootDir, func(absPath string, d fs.DirEntry, walkErr error) error {
			if walkErr != nil || d.IsDir() || !strings.HasSuffix(strings.ToLower(d.Name()), ".md") {
				return nil
			}
			relRaw, err := filepath.Rel(projectDir, absPath)
			if err != nil {
				return nil
			}
			relPath := filepath.ToSlash(relRaw)
			rawBytes, err := os.ReadFile(absPath)
			if err != nil {
				return nil
			}
			content := string(rawBytes)
			fm, body := parseMarkdownFrontmatter(content)
			tags := extractNoteTags(content, fm)
			noteTargets, paperKeys := extractWikiTargets(content)

			lineCount := strings.Count(strings.ReplaceAll(content, "\r\n", "\n"), "\n") + 1
			byteSize := len(rawBytes)
			title := strings.TrimSuffix(filepath.Base(absPath), filepath.Ext(absPath))

			kind := defaultKind
			if defaultKind != "blackboard" {
				switch {
				case strings.EqualFold(relPath, "notes/MOC.md") || fm.Type == "moc":
					kind = "moc"
				case strings.HasPrefix(relPath, "notes/artifacts/") || fm.Type == "artifact":
					kind = "artifact"
				case strings.HasPrefix(relPath, "notes/concepts/") || fm.Type == "concept":
					kind = "concept"
				default:
					kind = "note"
				}
			}

			bloated := false
			bloatReason := ""
			if kind != "blackboard" && !isUtilityHumanNote(relPath) {
				if lineCount > curatedBrainMaxLines {
					bloated = true
					bloatReason = fmt.Sprintf("%d lines exceeds %d-line limit", lineCount, curatedBrainMaxLines)
				} else if byteSize > curatedBrainMaxBytes {
					bloated = true
					bloatReason = fmt.Sprintf("%d bytes exceeds %d-byte limit", byteSize, curatedBrainMaxBytes)
				}
			}

			nodeID := "note:" + relPath
			if kind == "blackboard" {
				nodeID = "blackboard:" + relPath
			}

			nodeMap[nodeID] = &BrainNode{
				ID:          nodeID,
				Label:       title,
				Kind:        kind,
				Path:        relPath,
				Tags:        tags,
				Aliases:     fm.Aliases,
				Status:      fm.Status,
				Lines:       lineCount,
				Bytes:       byteSize,
				Bloated:     bloated,
				BloatReason: bloatReason,
				Snippet:     extractFirstSnippet(body),
			}

			slug := strings.TrimSuffix(strings.TrimPrefix(relPath, "notes/"), ".md")
			slug = strings.TrimPrefix(slug, ".dupe/brain/")
			parsedNotes = append(parsedNotes, parsedNote{
				nodeID:      nodeID,
				relPath:     relPath,
				slug:        slug,
				title:       title,
				aliases:     fm.Aliases,
				noteTargets: noteTargets,
				paperKeys:   paperKeys,
			})

			reg := func(k string) {
				nk := strings.ToLower(strings.TrimSpace(strings.TrimPrefix(k, "notes/")))
				nk = strings.TrimSuffix(nk, ".md")
				if nk != "" {
					if _, exists := lookup[nk]; !exists {
						lookup[nk] = nodeID
					}
				}
			}
			reg(slug)
			reg(strings.TrimPrefix(slug, "concepts/"))
			reg(strings.TrimPrefix(slug, "artifacts/"))
			reg(title)
			for _, a := range fm.Aliases {
				reg(a)
			}
			return nil
		})
	}

	scanMarkdownRoot(filepath.Join(projectDir, "notes"), "note")
	if opts.IncludeAgentBrain {
		scanMarkdownRoot(filepath.Join(projectDir, ".dupe", "brain"), "blackboard")
	}

	// Register reference papers so links from notes & .tex attach to real paper nodes.
	refByKey := make(map[string]RefIndexEntry, len(refs))
	for _, r := range refs {
		if r.BibtexKey == "" {
			continue
		}
		refByKey[strings.ToLower(r.BibtexKey)] = r
		pid := "paper:" + r.BibtexKey
		nodeMap[pid] = &BrainNode{
			ID:      pid,
			Label:   "@" + r.BibtexKey,
			Kind:    "paper",
			Path:    filepath.ToSlash(filepath.Join("refs", "text", r.BibtexKey+".md")),
			Tags:    r.Tags,
			Snippet: r.Title,
		}
	}

	ensurePaperNode := func(key string) string {
		pid := "paper:" + key
		if _, exists := nodeMap[pid]; exists {
			return pid
		}
		if r, ok := refByKey[strings.ToLower(key)]; ok {
			pid = "paper:" + r.BibtexKey
			if _, exists := nodeMap[pid]; !exists {
				nodeMap[pid] = &BrainNode{
					ID:      pid,
					Label:   "@" + r.BibtexKey,
					Kind:    "paper",
					Path:    filepath.ToSlash(filepath.Join("refs", "text", r.BibtexKey+".md")),
					Tags:    r.Tags,
					Snippet: r.Title,
				}
			}
			return pid
		}
		nodeMap[pid] = &BrainNode{
			ID:    pid,
			Label: "@" + key,
			Kind:  "paper",
			Path:  "",
		}
		return pid
	}

	// Connect note -> note / ghost and note -> paper edges.
	for _, pn := range parsedNotes {
		for _, target := range pn.noteTargets {
			norm := strings.ToLower(strings.TrimSpace(strings.TrimPrefix(strings.ReplaceAll(target, "\\", "/"), "notes/")))
			norm = strings.TrimSuffix(norm, ".md")
			if norm == "" {
				continue
			}
			if dstID, ok := lookup[norm]; ok {
				addEdge(pn.nodeID, dstID, "wikilink", 0, "")
				continue
			}
			ghostID := "ghost:" + norm
			if _, exists := nodeMap[ghostID]; !exists {
				nodeMap[ghostID] = &BrainNode{
					ID:    ghostID,
					Label: target,
					Kind:  "ghost",
					Path:  "notes/concepts/" + sanitizeBrainSlug(target) + ".md",
				}
			}
			addEdge(pn.nodeID, ghostID, "wikilink", 0, "")
		}
		for _, key := range pn.paperKeys {
			pid := ensurePaperNode(key)
			addEdge(pn.nodeID, pid, "cite", 0, "")
		}
	}

	// Scan paper/*.tex for \cite{key} edges.
	paperDir := filepath.Join(projectDir, "paper")
	if _, err := os.Stat(paperDir); err == nil {
		_ = filepath.WalkDir(paperDir, func(absPath string, d fs.DirEntry, walkErr error) error {
			if walkErr != nil || d.IsDir() || !strings.HasSuffix(strings.ToLower(d.Name()), ".tex") {
				return nil
			}
			relRaw, err := filepath.Rel(projectDir, absPath)
			if err != nil {
				return nil
			}
			relPath := filepath.ToSlash(relRaw)
			texBytes, err := os.ReadFile(absPath)
			if err != nil {
				return nil
			}
			texID := "tex:" + relPath
			nodeMap[texID] = &BrainNode{
				ID:    texID,
				Label: filepath.Base(relPath),
				Kind:  "tex",
				Path:  relPath,
			}
			for _, m := range latexCitePattern.FindAllStringSubmatch(string(texBytes), -1) {
				if len(m) < 2 {
					continue
				}
				for _, rawKey := range strings.Split(m[1], ",") {
					key := strings.TrimSpace(rawKey)
					if key == "" {
						continue
					}
					pid := ensurePaperNode(key)
					addEdge(texID, pid, "cite", 0, "")
				}
			}
			return nil
		})
	}

	// Connect Code-to-Paper provenance links if recorded.
	if provEntries, pErr := readProvenanceEntries(projectDir); pErr == nil {
		for _, pr := range provEntries {
			codeID := "code:" + pr.SourceScript
			if _, ok := nodeMap[codeID]; !ok {
				nodeMap[codeID] = &BrainNode{
					ID:      codeID,
					Label:   filepath.Base(pr.SourceScript),
					Kind:    "code",
					Path:    pr.SourceScript,
					Snippet: pr.Command,
				}
			}
			dstID := "asset:" + pr.TargetPath
			if _, ok := nodeMap[dstID]; !ok {
				nodeMap[dstID] = &BrainNode{
					ID:    dstID,
					Label: filepath.Base(pr.TargetPath),
					Kind:  "tex",
					Path:  pr.TargetPath,
				}
			}
			addEdge(codeID, dstID, "provenance", 0, pr.Notes)
		}
	}

	// Compute degree and incoming backlinks.
	for _, e := range edges {
		if src, ok := nodeMap[e.Source]; ok {
			src.Degree++
		}
		if dst, ok := nodeMap[e.Target]; ok {
			dst.Degree++
			dst.Backlinks++
		}
	}

	// Collect blackboard topics always (for summary visibility even when blackboard nodes are filtered out).
	var blackboardTopics []string
	brainDir := filepath.Join(projectDir, ".dupe", "brain", "topics")
	if entries, err := os.ReadDir(brainDir); err == nil {
		for _, e := range entries {
			if !e.IsDir() && strings.HasSuffix(e.Name(), ".md") {
				blackboardTopics = append(blackboardTopics, strings.TrimSuffix(e.Name(), ".md"))
			}
		}
		sort.Strings(blackboardTopics)
	}

	// Build summary from full graph before optional focus filtering.
	var summary BrainGraphSummary
	summary.BlackboardTopics = blackboardTopics
	var hubs []BrainHubSummary
	for _, n := range nodeMap {
		switch n.Kind {
		case "note", "concept", "moc":
			summary.CuratedNoteCount++
		case "artifact":
			summary.ArtifactCount++
		case "blackboard":
			summary.BlackboardCount++
		case "ghost":
			summary.GhostCount++
			summary.Ghosts = append(summary.Ghosts, n.Label)
		}
		if n.Bloated {
			summary.BloatedCount++
			summary.BloatedNotes = append(summary.BloatedNotes, fmt.Sprintf("%s (%s)", n.Path, n.BloatReason))
		}
		if (n.Kind == "note" || n.Kind == "concept" || n.Kind == "artifact") && !isUtilityHumanNote(n.Path) && n.Degree == 0 {
			summary.OrphanCount++
			summary.Orphans = append(summary.Orphans, n.Path)
		}
		if n.Backlinks > 0 && n.Kind != "ghost" && n.Kind != "blackboard" {
			hubs = append(hubs, BrainHubSummary{
				ID:        n.ID,
				Label:     n.Label,
				Path:      n.Path,
				Backlinks: n.Backlinks,
				Degree:    n.Degree,
			})
		}
	}
	sort.Slice(hubs, func(i, j int) bool {
		if hubs[i].Backlinks != hubs[j].Backlinks {
			return hubs[i].Backlinks > hubs[j].Backlinks
		}
		return hubs[i].Degree > hubs[j].Degree
	})
	if len(hubs) > 8 {
		hubs = hubs[:8]
	}
	summary.TopHubs = hubs
	sort.Strings(summary.Orphans)
	sort.Strings(summary.Ghosts)
	sort.Strings(summary.BloatedNotes)

	// Optional focus BFS filter (e.g. local 1-2 hop neighborhood).
	if focus := strings.TrimSpace(opts.Focus); focus != "" {
		depth := opts.Depth
		if depth <= 0 {
			depth = 2
		}
		focusID := focus
		if _, ok := nodeMap[focusID]; !ok {
			if mapped, ok2 := lookup[strings.ToLower(strings.TrimSuffix(strings.TrimPrefix(focus, "notes/"), ".md"))]; ok2 {
				focusID = mapped
			} else if _, ok3 := nodeMap["note:"+focus]; ok3 {
				focusID = "note:" + focus
			} else if _, ok4 := nodeMap["paper:"+focus]; ok4 {
				focusID = "paper:" + focus
			} else if _, ok5 := nodeMap["tex:"+focus]; ok5 {
				focusID = "tex:" + focus
			}
		}
		if _, ok := nodeMap[focusID]; ok {
			keepNodes := map[string]bool{focusID: true}
			frontier := []string{focusID}
			for step := 0; step < depth && len(frontier) > 0; step++ {
				var nextFrontier []string
				for _, cur := range frontier {
					for _, e := range edges {
						if e.Source == cur && !keepNodes[e.Target] {
							keepNodes[e.Target] = true
							nextFrontier = append(nextFrontier, e.Target)
						} else if e.Target == cur && !keepNodes[e.Source] {
							keepNodes[e.Source] = true
							nextFrontier = append(nextFrontier, e.Source)
						}
					}
				}
				frontier = nextFrontier
			}
			filteredNodes := make(map[string]*BrainNode)
			for id := range keepNodes {
				filteredNodes[id] = nodeMap[id]
			}
			var filteredEdges []BrainEdge
			for _, e := range edges {
				if keepNodes[e.Source] && keepNodes[e.Target] {
					filteredEdges = append(filteredEdges, e)
				}
			}
			nodeMap = filteredNodes
			edges = filteredEdges
		}
	}

	nodes := make([]BrainNode, 0, len(nodeMap))
	for _, n := range nodeMap {
		nodes = append(nodes, *n)
	}
	sort.Slice(nodes, func(i, j int) bool {
		if nodes[i].Kind != nodes[j].Kind {
			return nodes[i].Kind < nodes[j].Kind
		}
		return nodes[i].Label < nodes[j].Label
	})
	sort.Slice(edges, func(i, j int) bool {
		if edges[i].Source != edges[j].Source {
			return edges[i].Source < edges[j].Source
		}
		return edges[i].Target < edges[j].Target
	})

	summary.TotalNodes = len(nodes)
	summary.TotalEdges = len(edges)
	_ = ctx

	return BrainGraph{
		Nodes:   nodes,
		Edges:   edges,
		Summary: summary,
	}
}

func ensureAgentBrainInitialized(projectDir string) error {
	brainDir := filepath.Join(projectDir, ".dupe", "brain")
	topicsDir := filepath.Join(brainDir, "topics")
	if err := os.MkdirAll(topicsDir, 0o755); err != nil {
		return err
	}
	boardPath := filepath.Join(brainDir, "blackboard.md")
	if _, err := os.Stat(boardPath); os.IsNotExist(err) {
		seed := strings.Join([]string{
			"# Agent Brain & Blackboard (Gitignored)",
			"",
			"Agents use `.dupe/brain/` to share hypotheses, dead ends, and intermediate handoffs without bloating `notes/`.",
			"Promote verified, concise findings into `notes/concepts/<slug>.md` with `agent_brain_promote`.",
			"",
			"## Active Topics",
			"",
			"_No agent brainstorm entries yet._",
			"",
		}, "\n")
		if err := os.WriteFile(boardPath, []byte(seed), 0o644); err != nil {
			return err
		}
	}

	notesDir := filepath.Join(projectDir, "notes")
	conceptsDir := filepath.Join(notesDir, "concepts")
	if err := os.MkdirAll(conceptsDir, 0o755); err != nil {
		return err
	}
	mocPath := filepath.Join(notesDir, "MOC.md")
	if _, err := os.Stat(mocPath); os.IsNotExist(err) {
		mocSeed := strings.Join([]string{
			"---",
			"type: moc",
			"status: active",
			"tags: [moc, brain]",
			"---",
			"",
			"# Map of Content",
			"",
			"Central index linking concise research claims in `notes/concepts/`, key results in `notes/artifacts/`, and references in `refs/`.",
			"",
			"## Core Concepts",
			"",
			"## Key Artifacts",
			"",
			"## Open Questions",
			"",
		}, "\n")
		_ = os.WriteFile(mocPath, []byte(mocSeed), 0o644)
	}
	return nil
}

func refreshAgentBlackboardIndex(projectDir string) {
	brainDir := filepath.Join(projectDir, ".dupe", "brain")
	topicsDir := filepath.Join(brainDir, "topics")
	entries, err := os.ReadDir(topicsDir)
	if err != nil {
		return
	}
	var bullets []string
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".md") {
			continue
		}
		slug := strings.TrimSuffix(e.Name(), ".md")
		info, _ := e.Info()
		lines := 0
		if raw, rErr := os.ReadFile(filepath.Join(topicsDir, e.Name())); rErr == nil {
			lines = strings.Count(strings.ReplaceAll(string(raw), "\r\n", "\n"), "\n") + 1
		}
		mod := ""
		if info != nil {
			mod = info.ModTime().UTC().Format("2006-01-02 15:04 UTC")
		}
		bullets = append(bullets, fmt.Sprintf("- `topics/%s.md` (%d lines, updated %s)", slug, lines, mod))
	}
	sort.Strings(bullets)
	var b strings.Builder
	b.WriteString("# Agent Brain & Blackboard (Gitignored)\n\n")
	b.WriteString("Agents use `.dupe/brain/` to share hypotheses, dead ends, and intermediate handoffs without bloating `notes/`.\n")
	b.WriteString("Promote verified, concise findings into `notes/concepts/<slug>.md` with `agent_brain_promote`.\n\n")
	b.WriteString("## Active Topics\n\n")
	if len(bullets) == 0 {
		b.WriteString("_No agent brainstorm entries yet._\n")
	} else {
		for _, line := range bullets {
			b.WriteString(line + "\n")
		}
	}
	_ = writeFileIfChanged(filepath.Join(brainDir, "blackboard.md"), []byte(b.String()), 0o644)
}

func postAgentBlackboardEntry(projectDir, topic, agentName, summary, body string, links []string) (string, error) {
	if err := ensureAgentBrainInitialized(projectDir); err != nil {
		return "", err
	}
	slug := sanitizeBrainSlug(topic)
	if strings.TrimSpace(agentName) == "" {
		agentName = "agent"
	}
	topicPath := filepath.Join(projectDir, ".dupe", "brain", "topics", slug+".md")

	existingBytes, _ := os.ReadFile(topicPath)
	var b strings.Builder
	if len(existingBytes) == 0 {
		b.WriteString(fmt.Sprintf("---\ntype: blackboard\ntopic: %s\nstatus: active\n---\n\n# Agent Brainstorm: %s\n\n", slug, strings.TrimSpace(topic)))
	} else {
		b.Write(existingBytes)
		if !strings.HasSuffix(string(existingBytes), "\n") {
			b.WriteByte('\n')
		}
		b.WriteByte('\n')
	}

	stamp := time.Now().UTC().Format("2006-01-02 15:04 UTC")
	b.WriteString(fmt.Sprintf("## [%s] %s", stamp, strings.TrimSpace(agentName)))
	if strings.TrimSpace(summary) != "" {
		b.WriteString(" — " + strings.TrimSpace(summary))
	}
	b.WriteString("\n\n")
	if strings.TrimSpace(body) != "" {
		b.WriteString(strings.TrimSpace(body) + "\n\n")
	}
	if len(links) > 0 {
		var cleanLinks []string
		for _, l := range links {
			l = strings.TrimSpace(l)
			if l == "" {
				continue
			}
			if !strings.HasPrefix(l, "[[") {
				l = "[[" + l + "]]"
			}
			cleanLinks = append(cleanLinks, l)
		}
		if len(cleanLinks) > 0 {
			b.WriteString("**Links:** " + strings.Join(cleanLinks, " · ") + "\n")
		}
	}
	if err := os.WriteFile(topicPath, []byte(b.String()), 0o644); err != nil {
		return "", err
	}
	refreshAgentBlackboardIndex(projectDir)
	return filepath.ToSlash(filepath.Join(".dupe", "brain", "topics", slug+".md")), nil
}

func readAgentBlackboard(projectDir, topic, query string, maxLines int) (string, error) {
	if err := ensureAgentBrainInitialized(projectDir); err != nil {
		return "", err
	}
	if maxLines <= 0 {
		maxLines = 200
	}
	var targetPath string
	if strings.TrimSpace(topic) != "" {
		slug := sanitizeBrainSlug(topic)
		targetPath = filepath.Join(projectDir, ".dupe", "brain", "topics", slug+".md")
	} else {
		targetPath = filepath.Join(projectDir, ".dupe", "brain", "blackboard.md")
	}
	rawBytes, err := os.ReadFile(targetPath)
	if err != nil {
		return "", fmt.Errorf("blackboard entry %q not found: %w", filepath.Base(targetPath), err)
	}
	text := strings.ReplaceAll(string(rawBytes), "\r\n", "\n")
	if q := strings.ToLower(strings.TrimSpace(query)); q != "" {
		var matched []string
		for _, sec := range strings.Split(text, "\n## ") {
			if strings.Contains(strings.ToLower(sec), q) {
				matched = append(matched, sec)
			}
		}
		if len(matched) == 0 {
			return fmt.Sprintf("No matches for %q in %s.", query, filepath.Base(targetPath)), nil
		}
		text = strings.Join(matched, "\n## ")
	}
	lines := strings.Split(text, "\n")
	if len(lines) > maxLines {
		lines = lines[len(lines)-maxLines:]
		return "(showing last lines)\n" + strings.Join(lines, "\n"), nil
	}
	return text, nil
}

func writeCuratedBrainNote(projectDir, relPath, content string, force bool) (string, error) {
	cleanRel := filepath.ToSlash(filepath.Clean(strings.TrimSpace(relPath)))
	if !strings.HasPrefix(cleanRel, "notes/") {
		cleanRel = filepath.ToSlash(filepath.Join("notes", "concepts", sanitizeBrainSlug(strings.TrimSuffix(cleanRel, ".md"))+".md"))
	}
	if !strings.HasSuffix(strings.ToLower(cleanRel), ".md") {
		cleanRel += ".md"
	}
	if isProtectedProjectPath(cleanRel) {
		return "", fmt.Errorf("refusing to overwrite protected path %s", cleanRel)
	}
	absPath, err := safeJoin(projectDir, cleanRel)
	if err != nil {
		return "", err
	}

	norm := strings.ReplaceAll(content, "\r\n", "\n")
	lines := strings.Count(norm, "\n") + 1
	bytesLen := len(norm)

	if !force {
		if lines > curatedBrainMaxLines {
			return "", fmt.Errorf("anti-bloat rejection: %s has %d lines (limit %d); condense it with Mermaid/bullets or post raw thoughts to agent_brain_post in .dupe/brain/", cleanRel, lines, curatedBrainMaxLines)
		}
		if bytesLen > curatedBrainMaxBytes {
			return "", fmt.Errorf("anti-bloat rejection: %s is %d bytes (limit %d); condense it or move verbose brainstorming to .dupe/brain/", cleanRel, bytesLen, curatedBrainMaxBytes)
		}
		if !isUtilityHumanNote(cleanRel) && cleanRel != "notes/MOC.md" {
			noteTargets, paperKeys := extractWikiTargets(norm)
			if len(noteTargets) == 0 && len(paperKeys) == 0 {
				return "", fmt.Errorf("curated brain note %s must include at least one Obsidian link (e.g. [[MOC]], [[related-concept]], or [[paper:key]]) to avoid orphan clutter", cleanRel)
			}
		}
	}

	if err := os.MkdirAll(filepath.Dir(absPath), 0o755); err != nil {
		return "", err
	}
	if !strings.HasSuffix(norm, "\n") {
		norm += "\n"
	}
	if err := os.WriteFile(absPath, []byte(norm), 0o644); err != nil {
		return "", err
	}
	return cleanRel, nil
}

func promoteBlackboardTopic(projectDir, sourceTopic, conceptSlug, content string, force bool) (string, error) {
	if err := ensureAgentBrainInitialized(projectDir); err != nil {
		return "", err
	}
	slug := sanitizeBrainSlug(conceptSlug)
	targetRel := filepath.ToSlash(filepath.Join("notes", "concepts", slug+".md"))
	writtenRel, err := writeCuratedBrainNote(projectDir, targetRel, content, force)
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(sourceTopic) != "" {
		_, _ = postAgentBlackboardEntry(
			projectDir,
			sourceTopic,
			"brain-promoter",
			"Promoted to curated concept note",
			fmt.Sprintf("Synthesized and promoted into [[concepts/%s]] (`%s`).", slug, writtenRel),
			[]string{"concepts/" + slug},
		)
	}
	return writtenRel, nil
}

func (s *Server) handleGetProjectBrain(w http.ResponseWriter, r *http.Request) {
	claims, ok := currentUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	projectID := r.PathValue("id")
	cfg, projDir, err := s.lookupProjectDir(r.Context(), claims.UserID, projectID, claims.Username)
	if err != nil {
		writeError(w, http.StatusNotFound, "project not found")
		return
	}
	papers, err := s.queryLinkedPapersForProject(r.Context(), claims.UserID, cfg)
	if err != nil {
		papers = nil
	}
	refs := make([]RefIndexEntry, 0, len(papers))
	for _, p := range papers {
		refs = append(refs, RefIndexEntry{
			PaperID:         p.ID,
			BibtexKey:       p.BibtexKey,
			Title:           p.Title,
			Authors:         p.Authors,
			PublicationYear: p.PublicationYear,
			DOI:             p.DOI,
			Tags:            p.Tags,
		})
	}
	depth, _ := strconv.Atoi(r.URL.Query().Get("depth"))
	includeAgentBrain := r.URL.Query().Get("include_agent_brain") == "1" || strings.EqualFold(r.URL.Query().Get("include_agent_brain"), "true")
	graph := buildProjectBrainGraph(r.Context(), projDir, refs, BrainGraphOptions{
		IncludeAgentBrain: includeAgentBrain,
		Focus:             r.URL.Query().Get("focus"),
		Depth:             depth,
	})
	writeJSON(w, http.StatusOK, graph)
}
