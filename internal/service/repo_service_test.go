package service

import "testing"

func TestOpenReturnsOpenedElsewhereWithoutRepoDetails(t *testing.T) {
	old := focusedWindowForRepo
	t.Cleanup(func() { focusedWindowForRepo = old })
	focusedWindowForRepo = func(string) (focusableWindow, bool) {
		return fakeFocusWindow{focused: func() {}}, true
	}

	got, err := (&RepoService{}).open("/repo")
	if err != nil {
		t.Fatal(err)
	}
	if got == nil || !got.OpenedElsewhere || got.ID != "/repo" || got.Path != "/repo" || got.Name != "" {
		t.Fatalf("open() = %#v; want ID/path only with openedElsewhere", got)
	}
}

type fakeFocusWindow struct{ focused func() }

func (w fakeFocusWindow) Focus() { w.focused() }
