package logviewer

import (
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/tidwall/gjson"
)

type Entry struct {
	Name      string  `json:"name"`
	ID        string  `json:"id"`
	Time      string  `json:"time"`
	Method    string  `json:"method"`
	URL       string  `json:"url"`
	Model     string  `json:"model"`
	Transport string  `json:"transport"`
	Status    int     `json:"status"`
	Duration  float64 `json:"duration"`
	Size      int64   `json:"size"`
	Note      string  `json:"note,omitempty"`
}

type Section struct {
	Name string `json:"name"`
	Text string `json:"text"`
}

var sectionMarker = regexp.MustCompile(`(?m)^=== (REQUEST INFO|HEADERS|REQUEST BODY|RESPONSE|API REQUEST(?: \d+)?|API RESPONSE(?: \d+)?|API ERROR RESPONSE(?: \d+)?|API RESPONSE ERROR(?: \d+)?|WEBSOCKET TIMELINE|API WEBSOCKET TIMELINE) ===\r?\n`)

func splitSections(raw string) []Section {
	matches := sectionMarker.FindAllStringSubmatchIndex(raw, -1)
	sections := make([]Section, 0, len(matches))
	for i, match := range matches {
		end := len(raw)
		if i+1 < len(matches) {
			end = matches[i+1][0]
		}
		sections = append(sections, Section{Name: raw[match[2]:match[3]], Text: raw[match[1]:end]})
	}
	if len(sections) == 0 {
		sections = append(sections, Section{Name: "UNRECOGNIZED LOG", Text: raw})
	}
	return sections
}

func header(text, name string) string {
	for _, line := range strings.Split(text, "\n") {
		if strings.HasPrefix(line, name+": ") {
			return strings.TrimSpace(strings.TrimPrefix(line, name+": "))
		}
	}
	return ""
}

func basicEntry(info os.FileInfo) Entry {
	stem := strings.TrimSuffix(info.Name(), ".log")
	id := stem[strings.LastIndex(stem, "-")+1:]
	return Entry{Name: info.Name(), ID: id, Time: info.ModTime().Format(time.RFC3339Nano), Size: info.Size(), Transport: "HTTP"}
}

func summarize(info os.FileInfo, sections []Section) Entry {
	entry := basicEntry(info)
	for _, section := range sections {
		switch section.Name {
		case "REQUEST INFO":
			entry.Method = header(section.Text, "Method")
			entry.URL = header(section.Text, "URL")
			if timestamp, errParse := time.Parse(time.RFC3339Nano, header(section.Text, "Timestamp")); errParse == nil {
				entry.Time = timestamp.Format(time.RFC3339Nano)
				entry.Duration = max(0, info.ModTime().Sub(timestamp).Seconds())
			}
			if strings.EqualFold(header(section.Text, "Downstream Transport"), "websocket") {
				entry.Transport = "WebSocket"
			}
		case "REQUEST BODY":
			entry.Model = gjson.Get(section.Text, "model").String()
			if gjson.Get(section.Text, "stream").Bool() && entry.Transport != "WebSocket" {
				entry.Transport = "Stream"
			}
		case "RESPONSE":
			entry.Status, _ = strconv.Atoi(header(section.Text, "Status"))
		case "WEBSOCKET TIMELINE":
			entry.Transport = "WebSocket"
			for _, line := range strings.Split(section.Text, "\n") {
				if start := strings.Index(line, "{"); start >= 0 {
					if model := gjson.Get(line[start:], "model").String(); model != "" && entry.Model == "" {
						entry.Model = model
					}
				}
			}
		}
	}
	return entry
}
