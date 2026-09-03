// Package logviewer provides a read-only, loopback-only request log browser.
package logviewer

import (
	"embed"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	log "github.com/sirupsen/logrus"
)

//go:embed assets/index.html assets/viewer.css assets/viewer.js assets/parser.js assets/markdown.js assets/vendor
var assets embed.FS

const maxDetailSize = 64 << 20

var requestFilename = regexp.MustCompile(`^.+-\d{4}-\d{2}-\d{2}T\d{6}-[A-Za-z0-9_-]+\.log$`)

type cachedEntry struct {
	modified time.Time
	size     int64
	entry    Entry
}

type Handler struct {
	dir   string
	mu    sync.Mutex
	cache map[string]cachedEntry
}

func New(dir string) *Handler {
	return &Handler{dir: dir, cache: make(map[string]cachedEntry)}
}

func (h *Handler) Register(engine *gin.Engine) {
	group := engine.Group("/logs", localOnly)
	group.GET("", serveAsset("index.html", "text/html; charset=utf-8"))
	group.GET("/", serveAsset("index.html", "text/html; charset=utf-8"))
	group.GET("/viewer.css", serveAsset("viewer.css", "text/css; charset=utf-8"))
	group.GET("/viewer.js", serveAsset("viewer.js", "text/javascript; charset=utf-8"))
	group.GET("/parser.js", serveAsset("parser.js", "text/javascript; charset=utf-8"))
	group.GET("/markdown.js", serveAsset("markdown.js", "text/javascript; charset=utf-8"))
	group.GET("/vendor/marked.umd.js", serveAsset("vendor/marked.umd.js", "text/javascript; charset=utf-8"))
	group.GET("/vendor/purify.min.js", serveAsset("vendor/purify.min.js", "text/javascript; charset=utf-8"))
	group.GET("/api/entries", h.list)
	group.GET("/api/entries/:name", h.detail)
	group.GET("/api/entries/:name/raw", h.raw)
}

// Check the actual peer, never forwarded headers. Host and Origin checks also
// prevent DNS rebinding and cross-origin reads of sensitive conversation data.
func localOnly(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	c.Header("X-Content-Type-Options", "nosniff")
	c.Header("Referrer-Policy", "no-referrer")
	c.Header("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'")
	c.Header("Cross-Origin-Resource-Policy", "same-origin")
	c.Writer.Header().Del("Access-Control-Allow-Origin")
	peer, _, errPeer := net.SplitHostPort(c.Request.RemoteAddr)
	ip := net.ParseIP(peer)
	if errPeer != nil || ip == nil || !ip.IsLoopback() || !loopbackHost(c.Request.Host) {
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "Log viewer is available only on localhost."})
		return
	}
	if origin := c.GetHeader("Origin"); origin != "" {
		parsed, errParse := url.Parse(origin)
		scheme := "http"
		if c.Request.TLS != nil {
			scheme = "https"
		}
		if errParse != nil || parsed.Scheme != scheme || !strings.EqualFold(parsed.Host, c.Request.Host) || parsed.User != nil || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
			c.AbortWithStatus(http.StatusForbidden)
			return
		}
	}
	if site := c.GetHeader("Sec-Fetch-Site"); site != "" && site != "none" && site != "same-origin" {
		c.AbortWithStatus(http.StatusForbidden)
		return
	}
	c.Next()
}

func loopbackHost(host string) bool {
	if name, _, err := net.SplitHostPort(host); err == nil {
		host = name
	}
	host = strings.Trim(host, "[]")
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func serveAsset(name, contentType string) gin.HandlerFunc {
	return func(c *gin.Context) {
		data, errRead := assets.ReadFile("assets/" + name)
		if errRead != nil {
			c.Status(http.StatusInternalServerError)
			return
		}
		c.Data(http.StatusOK, contentType, data)
	}
}

func closeFile(file io.Closer) {
	if errClose := file.Close(); errClose != nil {
		log.WithError(errClose).Warn("failed to close log viewer file")
	}
}

func validName(name string) bool {
	return !strings.ContainsAny(name, `/\:`) && requestFilename.MatchString(name)
}

func (h *Handler) open(name string) (*os.File, error) {
	if !validName(name) {
		return nil, os.ErrNotExist
	}
	root, errRoot := os.OpenRoot(h.dir)
	if errRoot != nil {
		return nil, errRoot
	}
	defer closeFile(root)
	info, errStat := root.Lstat(name)
	if errStat != nil {
		return nil, errStat
	}
	if !info.Mode().IsRegular() {
		return nil, os.ErrNotExist
	}
	// Root.Open confines path resolution even if a symlink is swapped in.
	return root.Open(name)
}

func (h *Handler) list(c *gin.Context) {
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	if page < 1 {
		page = 1
	}
	const pageSize = 50
	files, errRead := os.ReadDir(h.dir)
	if errRead != nil && !os.IsNotExist(errRead) {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Unable to read the request log directory."})
		return
	}
	infos := make([]os.FileInfo, 0, len(files))
	query := strings.ToLower(strings.TrimSpace(c.Query("q")))
	for _, file := range files {
		if !validName(file.Name()) || !strings.Contains(strings.ToLower(file.Name()), query) {
			continue
		}
		if info, errInfo := file.Info(); errInfo == nil && info.Mode().IsRegular() {
			infos = append(infos, info)
		}
	}
	sort.Slice(infos, func(i, j int) bool {
		if infos[i].ModTime().Equal(infos[j].ModTime()) {
			return infos[i].Name() > infos[j].Name()
		}
		return infos[i].ModTime().After(infos[j].ModTime())
	})
	pages := max(1, (len(infos)+pageSize-1)/pageSize)
	page = min(page, pages)
	start := (page - 1) * pageSize
	entries := make([]Entry, 0, pageSize)
	for _, info := range infos[start:min(start+pageSize, len(infos))] {
		if c.Request.Context().Err() != nil {
			return
		}
		entries = append(entries, h.summary(info))
	}
	c.JSON(http.StatusOK, gin.H{"entries": entries, "total": len(infos), "page": page, "pages": pages, "page_size": pageSize})
}

func (h *Handler) summary(info os.FileInfo) Entry {
	h.mu.Lock()
	cached, ok := h.cache[info.Name()]
	h.mu.Unlock()
	if ok && cached.size == info.Size() && cached.modified.Equal(info.ModTime()) {
		return cached.entry
	}
	entry := basicEntry(info)
	if info.Size() > maxDetailSize {
		entry.Note = "Large log: use Download raw (over 64 MiB)."
		return entry
	}
	file, errOpen := h.open(info.Name())
	if errOpen != nil {
		entry.Note = "Log is no longer available. Refresh the list."
		return entry
	}
	defer closeFile(file)
	data, errRead := io.ReadAll(io.LimitReader(file, maxDetailSize+1))
	if errRead != nil || len(data) > maxDetailSize {
		entry.Note = "Unable to read log details."
		return entry
	}
	entry = summarize(info, splitSections(string(data)))
	h.mu.Lock()
	if len(h.cache) >= 2000 {
		clear(h.cache)
	}
	h.cache[info.Name()] = cachedEntry{modified: info.ModTime(), size: info.Size(), entry: entry}
	h.mu.Unlock()
	return entry
}

func (h *Handler) detail(c *gin.Context) {
	file, errOpen := h.open(c.Param("name"))
	if errOpen != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Request log not found. It may have been rotated."})
		return
	}
	defer closeFile(file)
	info, errStat := file.Stat()
	if errStat != nil || !info.Mode().IsRegular() {
		c.Status(http.StatusNotFound)
		return
	}
	if info.Size() > maxDetailSize {
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "This log exceeds the 64 MiB viewer limit. Download raw to view the complete file."})
		return
	}
	data, errRead := io.ReadAll(io.LimitReader(file, maxDetailSize+1))
	if errRead != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Unable to read this log."})
		return
	}
	if len(data) > maxDetailSize {
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "Log grew beyond the viewer limit. Download raw instead."})
		return
	}
	sections := splitSections(string(data))
	c.JSON(http.StatusOK, gin.H{"entry": summarize(info, sections), "sections": sections})
}

func (h *Handler) raw(c *gin.Context) {
	file, errOpen := h.open(c.Param("name"))
	if errOpen != nil {
		c.Status(http.StatusNotFound)
		return
	}
	defer closeFile(file)
	info, errStat := file.Stat()
	if errStat != nil || !info.Mode().IsRegular() {
		c.Status(http.StatusNotFound)
		return
	}
	c.Header("Content-Type", "text/plain; charset=utf-8")
	c.Header("Content-Disposition", `attachment; filename="`+info.Name()+`"`)
	http.ServeContent(c.Writer, c.Request, info.Name(), info.ModTime(), file)
}
