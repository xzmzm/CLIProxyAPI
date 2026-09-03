package api

import (
	"path/filepath"

	"github.com/router-for-me/CLIProxyAPI/v7/internal/api/handlers/logviewer"
	"github.com/router-for-me/CLIProxyAPI/v7/internal/logging"
)

func (s *Server) setupLogViewerRoutes() {
	dir := logging.ResolveLogDirectory(s.cfg)
	if source, ok := s.requestLogger.(interface{ LogDirectory() string }); ok {
		dir = source.LogDirectory()
	} else if !filepath.IsAbs(dir) {
		dir = filepath.Join(filepath.Dir(s.configFilePath), dir)
	}
	logviewer.New(dir).Register(s.engine)
}
