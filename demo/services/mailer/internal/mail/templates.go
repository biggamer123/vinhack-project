package mail

import (
	"html"
	"strings"
)

const layout = `<html><body style="font-family:sans-serif">{{content}}<hr><small>Inkwell</small></body></html>`

func RenderBody(text string) string {
	lines := strings.Split(text, "\n")
	for i, line := range lines {
		lines[i] = renderLine(line)
	}
	return strings.Replace(layout, "{{content}}", strings.Join(lines, ""), 1)
}

func renderLine(line string) string {
	escaped := html.EscapeString(line)
	if strings.HasPrefix(line, "- ") {
		return "<li>" + strings.TrimPrefix(escaped, "- ") + "</li>"
	}
	return "<p>" + escaped + "</p>"
}

func plainTextFallback(text string) string {
	return strings.ReplaceAll(text, "\n", "\r\n")
}
