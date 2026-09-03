package logviewer

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

const sampleLog = "=== REQUEST INFO ===\nURL: /v1/responses\nMethod: POST\nTimestamp: 2026-09-03T10:00:00Z\n\n\n=== HEADERS ===\nAuthorization: REDACTED\n\n\n=== REQUEST BODY ===\n{\"model\":\"example-model\",\"stream\":true,\"input\":\"hello\"}\n\n\n=== API REQUEST 1 ===\nBody:\n{\"input\":\"hello\"}\n\n\n=== API RESPONSE 1 ===\nStatus: 200\n\n\n=== RESPONSE ===\nStatus: 200\nContent-Type: text/event-stream\n\ndata: {\"type\":\"response.completed\",\"response\":{\"output\":[]}}\n\n"

func fixture(t *testing.T, dir, name, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func router(dir string) *gin.Engine {
	engine := gin.New()
	New(dir).Register(engine)
	return engine
}

func request(engine http.Handler, path string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, "http://localhost"+path, nil)
	req.RemoteAddr = "127.0.0.1:12345"
	response := httptest.NewRecorder()
	engine.ServeHTTP(response, req)
	return response
}

func TestLogViewerListAndDetails(t *testing.T) {
	dir := t.TempDir()
	name := "v1-responses-2026-09-03T100002-abc123.log"
	fixture(t, dir, name, sampleLog)
	fixture(t, dir, "main.log", "not a request")
	fixture(t, dir, "response-temp.log", "partial")
	stamp := time.Date(2026, 9, 3, 10, 0, 2, 0, time.UTC)
	if err := os.Chtimes(filepath.Join(dir, name), stamp, stamp); err != nil {
		t.Fatal(err)
	}
	engine := router(dir)
	response := request(engine, "/logs/api/entries")
	var list struct {
		Entries []Entry `json:"entries"`
		Total   int     `json:"total"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	if response.Code != 200 || list.Total != 1 || len(list.Entries) != 1 {
		t.Fatalf("unexpected list: %d %+v", response.Code, list)
	}
	entry := list.Entries[0]
	if entry.Model != "example-model" || entry.Status != 200 || entry.Transport != "Stream" || entry.Duration != 2 || entry.URL != "/v1/responses" {
		t.Fatalf("unexpected summary: %+v", entry)
	}
	detail := request(engine, "/logs/api/entries/"+name)
	var result struct {
		Sections []Section `json:"sections"`
	}
	if err := json.Unmarshal(detail.Body.Bytes(), &result); err != nil || len(result.Sections) != 6 {
		t.Fatalf("unexpected detail: %v %s", err, detail.Body.String())
	}
	raw := request(engine, "/logs/api/entries/"+name+"/raw")
	if raw.Code != 200 || raw.Body.String() != sampleLog {
		t.Fatal("raw download must preserve exact bytes")
	}
	if !strings.Contains(raw.Header().Get("Content-Disposition"), "attachment") || raw.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("missing download/security headers")
	}
	fixture(t, dir, name, strings.Replace(sampleLog, "example-model", "updated-model", 1))
	updated := request(engine, "/logs/api/entries")
	if !strings.Contains(updated.Body.String(), "updated-model") {
		t.Fatal("summary cache did not update after file changed")
	}
}

func TestLogViewerPaginationAndEmpty(t *testing.T) {
	dir := t.TempDir()
	engine := router(dir)
	if body := request(engine, "/logs/api/entries").Body.String(); !strings.Contains(body, `"entries":[]`) {
		t.Fatalf("empty array required: %s", body)
	}
	stamp := time.Date(2026, 9, 3, 10, 0, 0, 0, time.UTC)
	for i := 0; i < 53; i++ {
		name := fmt.Sprintf("v1-responses-2026-09-03T100000-%03d.log", i)
		fixture(t, dir, name, sampleLog)
		if err := os.Chtimes(filepath.Join(dir, name), stamp.Add(time.Duration(i)*time.Second), stamp.Add(time.Duration(i)*time.Second)); err != nil {
			t.Fatal(err)
		}
	}
	for _, test := range []struct {
		query              string
		page, count, total int
	}{
		{"", 1, 50, 53}, {"?page=2", 2, 3, 53}, {"?page=99999999", 2, 3, 53}, {"?page=-1", 1, 50, 53}, {"?q=052", 1, 1, 1}, {"?q=no-match", 1, 0, 0},
	} {
		var data struct {
			Entries     []Entry
			Page, Total int
		}
		response := request(engine, "/logs/api/entries"+test.query)
		if err := json.Unmarshal(response.Body.Bytes(), &data); err != nil {
			t.Fatal(err)
		}
		if data.Page != test.page || data.Total != test.total || len(data.Entries) != test.count {
			t.Fatalf("query %s: unexpected page %+v", test.query, data)
		}
		if test.query == "" && data.Entries[0].ID != "052" {
			t.Fatal("newest request must be first")
		}
	}
}

func TestLogViewerAccessControl(t *testing.T) {
	engine := router(t.TempDir())
	for _, test := range []struct {
		name, peer, host, origin, site, forwarded string
		status                                    int
	}{
		{"local", "127.0.0.1:123", "localhost:8317", "", "none", "", 200},
		{"ipv6", "[::1]:123", "[::1]:8317", "", "same-origin", "", 200},
		{"same origin", "127.0.0.1:123", "localhost:8317", "http://localhost:8317", "same-origin", "", 200},
		{"remote", "192.0.2.1:123", "localhost:8317", "", "", "127.0.0.1", 403},
		{"rebound host", "127.0.0.1:123", "evil.example:8317", "", "", "", 403},
		{"foreign origin", "127.0.0.1:123", "localhost:8317", "https://evil.example", "", "", 403},
		{"null origin", "127.0.0.1:123", "localhost:8317", "null", "", "", 403},
		{"other port", "127.0.0.1:123", "localhost:8317", "http://localhost:8000", "", "", 403},
		{"cross-site", "127.0.0.1:123", "localhost:8317", "", "cross-site", "", 403},
		{"same-site", "127.0.0.1:123", "localhost:8317", "", "same-site", "", 403},
	} {
		t.Run(test.name, func(t *testing.T) {
			for _, path := range []string{"/logs", "/logs/api/entries", "/logs/parser.js"} {
				req := httptest.NewRequest(http.MethodGet, "http://"+test.host+path, nil)
				req.RemoteAddr = test.peer
				req.Header.Set("Origin", test.origin)
				req.Header.Set("Sec-Fetch-Site", test.site)
				req.Header.Set("X-Forwarded-For", test.forwarded)
				response := httptest.NewRecorder()
				engine.ServeHTTP(response, req)
				if response.Code != test.status {
					t.Fatalf("%s: got %d want %d", path, response.Code, test.status)
				}
			}
		})
	}
}

func TestLogViewerRejectsUnsafePaths(t *testing.T) {
	dir := t.TempDir()
	fixture(t, dir, "main.log", "private app log")
	engine := router(dir)
	for _, name := range []string{"main.log", "..", "../config.yaml", `..\config.yaml`, "C:secret.log", "v1-responses-2026-09-03T100000-ok.log:secret"} {
		if validName(name) {
			t.Errorf("accepted unsafe name %q", name)
		}
	}
	for _, path := range []string{"/logs/api/entries/main.log", "/logs/api/entries/main.log/raw", "/logs/api/entries/v1-responses-2026-09-03T100000-missing.log"} {
		if response := request(engine, path); response.Code != 404 {
			t.Fatalf("%s: got %d", path, response.Code)
		}
	}
	outside := filepath.Join(t.TempDir(), "secret.log")
	if err := os.WriteFile(outside, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	name := "v1-responses-2026-09-03T100000-link.log"
	if err := os.Symlink(outside, filepath.Join(dir, name)); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if response := request(engine, "/logs/api/entries/"+name+"/raw"); response.Code != 404 {
		t.Fatal("symlink must not expose external file")
	}
}

func TestLogViewerAssetsAndMalformedLog(t *testing.T) {
	dir := t.TempDir()
	engine := router(dir)
	for _, path := range []string{"/logs", "/logs/", "/logs/viewer.css", "/logs/viewer.js", "/logs/parser.js", "/logs/markdown.js", "/logs/vendor/marked.umd.js", "/logs/vendor/purify.min.js"} {
		response := request(engine, path)
		if response.Code != 200 || response.Body.Len() == 0 || !strings.Contains(response.Header().Get("Content-Security-Policy"), "frame-ancestors 'none'") {
			t.Fatalf("missing embedded asset or security policy: %s", path)
		}
	}
	name := "error-v1-responses-2026-09-03T100000-error.log"
	fixture(t, dir, name, "<script>alert('untrusted')</script>\npartial file")
	response := request(engine, "/logs/api/entries/"+name)
	if response.Code != 200 || !strings.Contains(response.Body.String(), "UNRECOGNIZED LOG") || strings.Contains(response.Body.String(), "<script>") {
		t.Fatal("malformed logs must remain safely inspectable")
	}
}

func TestLogViewerAPIErrorSections(t *testing.T) {
	const raw = "=== API REQUEST 1 ===\nfirst request\n=== API ERROR RESPONSE ===\nHTTP Status: 429\nquota exceeded\n=== API REQUEST 2 ===\nretry\n=== API RESPONSE 2 ===\nStatus: 200\nsuccess\n=== RESPONSE ===\nStatus: 200\n"
	sections := splitSections(raw)
	if len(sections) != 5 || sections[1].Name != "API ERROR RESPONSE" || strings.Contains(sections[0].Text, "quota exceeded") {
		t.Fatalf("upstream errors must be separate sections: %+v", sections)
	}
}

func TestLogViewerCRLFAndWebsocket(t *testing.T) {
	sections := splitSections(strings.ReplaceAll(sampleLog, "\n", "\r\n"))
	if len(sections) != 6 || header(sections[0].Text, "Method") != "POST" {
		t.Fatal("CRLF parsing failed")
	}
	dir := t.TempDir()
	name := "v1-responses-2026-09-03T100000-ws.log"
	fixture(t, dir, name, "=== REQUEST INFO ===\nMethod: GET\nDownstream Transport: websocket\n\n=== WEBSOCKET TIMELINE ===\n{\"type\":\"response.create\",\"model\":\"ws-model\",\"input\":[]}\n")
	response := request(router(dir), "/logs/api/entries")
	if !strings.Contains(response.Body.String(), `"model":"ws-model"`) || !strings.Contains(response.Body.String(), `"transport":"WebSocket"`) {
		t.Fatal(response.Body.String())
	}
}
