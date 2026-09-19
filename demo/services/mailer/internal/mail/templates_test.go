package mail

import (
	"strings"
	"testing"
)

func TestRenderBodyEscapesAndLists(t *testing.T) {
	out := RenderBody("hello <b>\n- first post")
	if !strings.Contains(out, "&lt;b&gt;") {
		t.Fatalf("expected escaped html, got %s", out)
	}
	if !strings.Contains(out, "<li>first post</li>") {
		t.Fatalf("expected list item, got %s", out)
	}
}
