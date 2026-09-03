package api

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/router-for-me/CLIProxyAPI/v7/internal/config"
	"github.com/router-for-me/CLIProxyAPI/v7/internal/logging"
)

func TestLogViewerUsesRequestLoggerDirectory(t *testing.T) {
	dir := t.TempDir()
	name := "v1-responses-2026-09-03T100000-custom.log"
	if err := os.WriteFile(filepath.Join(dir, name), []byte("=== REQUEST BODY ===\n{\"model\":\"custom-logger-model\"}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	server := newTestServerWithOptions(t, WithRequestLoggerFactory(func(_ *config.Config, _ string) logging.RequestLogger {
		return logging.NewFileRequestLogger(false, dir, "", 0)
	}))
	for _, path := range []string{"/logs", "/logs/api/entries"} {
		req := httptest.NewRequest(http.MethodGet, "http://localhost:8317"+path, nil)
		req.RemoteAddr = "127.0.0.1:1234"
		response := httptest.NewRecorder()
		server.engine.ServeHTTP(response, req)
		if response.Code != http.StatusOK {
			t.Fatalf("%s: got status %d", path, response.Code)
		}
		if response.Header().Get("Access-Control-Allow-Origin") != "" {
			t.Fatal("log viewer must not inherit public API CORS access")
		}
		if path == "/logs/api/entries" && !strings.Contains(response.Body.String(), "custom-logger-model") {
			t.Fatal("viewer did not use the request logger's resolved directory")
		}
	}
}
