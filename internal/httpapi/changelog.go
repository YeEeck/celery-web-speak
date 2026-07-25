package httpapi

import (
	_ "embed"
	"encoding/json"
	"net/http"
	"strconv"
)

// appVersion 是当前应用版本号。
// 发版时需同步更新此常量与 web/package.json 的 version 字段。
const appVersion = "0.4.5"

//go:embed CHANGELOG.json
var changelogJSON []byte

type changelogEntry struct {
	Version string   `json:"version"`
	Date    string   `json:"date"`
	Changes []string `json:"changes"`
}

var changelogEntries []changelogEntry

func init() {
	if err := json.Unmarshal(changelogJSON, &changelogEntries); err != nil {
		panic("invalid CHANGELOG.json: " + err.Error())
	}
}

func (s *Server) handleVersion(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"version": appVersion})
}

func (s *Server) handleChangelog(w http.ResponseWriter, r *http.Request) {
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	if page < 1 {
		page = 1
	}
	size, _ := strconv.Atoi(r.URL.Query().Get("size"))
	if size < 1 {
		size = 5
	}
	if size > 50 {
		size = 50
	}

	total := len(changelogEntries)
	offset := (page - 1) * size

	var entries []changelogEntry
	if offset < total {
		end := offset + size
		if end > total {
			end = total
		}
		entries = changelogEntries[offset:end]
	} else {
		entries = []changelogEntry{}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"entries": entries,
		"total":   total,
		"page":    page,
		"size":    size,
	})
}
