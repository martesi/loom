package service

import (
	"encoding/base64"
	"loom/internal/store"
	"math"
	"os"
	"path/filepath"
	"testing"
)

func TestCanvasPlacementImportAndPurge(t *testing.T) {
	path := t.TempDir()
	s := &ImageService{}
	media := []ClipboardMedia{{Name: "a.png", Data: base64.StdEncoding.EncodeToString([]byte("original bytes"))}}
	ids, err := s.ImportMedia(path, media, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	r, err := store.Bootstrap(path)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	image, err := s.GetImage(path, ids[0])
	if err != nil || image.Placed {
		t.Fatalf("import placement: %+v %v", image, err)
	}
	if err := s.PlaceImages(path, ids, 12, 34, 0); err != nil {
		t.Fatal(err)
	}
	if err := s.PlaceImages(path, ids, 90, 90, 0); err != nil {
		t.Fatal(err)
	}
	image, err = s.GetImage(path, ids[0])
	if err != nil || image.CanvasX != 12 || image.CanvasY != 34 {
		t.Fatalf("repeat drop moved asset: %+v %v", image, err)
	}
	if err := s.UnplaceImages(path, ids); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(path, "a.png")); err != nil {
		t.Fatalf("unplace removed file: %v", err)
	}
	copied, err := s.CopyMedia(path, ids, false)
	if err != nil || len(copied) != 1 || copied[0].Data != media[0].Data {
		t.Fatalf("original bytes lost: %+v %v", copied, err)
	}
	fresh, err := s.ImportMedia(path, copied, true, 50, 60)
	if err != nil {
		t.Fatal(err)
	}
	image, err = s.GetImage(path, fresh[0])
	if err != nil || !image.Placed || image.FileName != "a (1).png" || image.GroupID != 0 || image.PromptText != "" {
		t.Fatalf("paste: %+v %v", image, err)
	}
	if err := s.PurgeImages(path, []int64{fresh[0], fresh[0]}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(image.FilePath); !os.IsNotExist(err) {
		t.Fatalf("purged file still exists: %v", err)
	}
	if _, err := s.GetImage(path, fresh[0]); err == nil {
		t.Fatal("purged identity remains")
	}
}
func TestSetDropIsRejected(t *testing.T) {
	path := t.TempDir()
	s := &ImageService{}
	g := &GroupService{}
	media := []ClipboardMedia{}
	for _, name := range []string{"a.png", "b.png", "c.png", "d.png"} {
		media = append(media, ClipboardMedia{Name: name, Data: "YQ=="})
	}
	ids, err := s.ImportMedia(path, media, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	first, err := g.CreateGroup(path, "first", "", ids[:2])
	if err != nil {
		t.Fatal(err)
	}
	second, err := g.CreateGroup(path, "second", "", ids[2:])
	if err != nil {
		t.Fatal(err)
	}
	if err := s.PlaceImages(path, []int64{ids[0], 99999}, 10, 20, second.ID); err == nil {
		t.Fatal("missing asset accepted")
	}
	image, err := s.GetImage(path, ids[0])
	if err != nil || image.Placed || image.GroupID != first.ID {
		t.Fatalf("partial set drop committed: %+v %v", image, err)
	}
	if err := s.PlaceImages(path, ids[:2], 10, 20, second.ID); err == nil {
		t.Fatal("set drop accepted")
	}
	r, err := store.Bootstrap(path)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	if _, err := r.GetGroup(first.ID); err != nil {
		t.Fatal("rejected drop changed the original set")
	}
	for _, id := range ids[:2] {
		image, err := s.GetImage(path, id)
		if err != nil || image.Placed || image.GroupID != first.ID {
			t.Fatalf("placement/membership: %+v %v", image, err)
		}
	}
}
func TestViewportAndImportFailure(t *testing.T) {
	path := t.TempDir()
	s := &ImageService{}
	if v, err := s.GetViewport(path); err != nil || v != nil {
		t.Fatalf("initial viewport: %+v %v", v, err)
	}
	want := Viewport{X: 123, Y: -456, Zoom: 1.25}
	if err := s.SetViewport(path, want); err != nil {
		t.Fatal(err)
	}
	for _, invalid := range []Viewport{
		{X: math.NaN(), Y: 0, Zoom: 1},
		{X: math.Inf(1), Y: 0, Zoom: 1},
		{X: 0, Y: math.NaN(), Zoom: 1},
		{X: 0, Y: math.Inf(-1), Zoom: 1},
		{X: 0, Y: 0, Zoom: math.NaN()},
		{X: 0, Y: 0, Zoom: math.Inf(1)},
		{X: 0, Y: 0, Zoom: 0},
		{X: 0, Y: 0, Zoom: -1},
	} {
		if err := s.SetViewport(path, invalid); err == nil {
			t.Fatalf("invalid viewport accepted: %+v", invalid)
		}
	}
	if v, err := s.GetViewport(path); err != nil || *v != want {
		t.Fatalf("viewport: %+v %v", v, err)
	}
	if _, err := s.ImportMedia(path, []ClipboardMedia{{Name: "good.png", Data: "YQ=="}, {Name: "bad.png", Data: "???"}}, false, 0, 0); err == nil {
		t.Fatal("invalid base64 accepted")
	}
	if _, err := os.Stat(filepath.Join(path, "good.png")); !os.IsNotExist(err) {
		t.Fatal("failed import left file behind")
	}
}

func TestImportMediaValidatesPayloadLimitsAndExtensions(t *testing.T) {
	path := t.TempDir()
	images := &ImageService{}
	atLimit := base64.StdEncoding.EncodeToString(make([]byte, maxClipboardItemBytes))
	if _, err := images.ImportMedia(path, []ClipboardMedia{{Name: "limit.png", Data: atLimit}}, false, 0, 0); err != nil {
		t.Fatalf("50 MiB item boundary rejected: %v", err)
	}
	overLimit := base64.StdEncoding.EncodeToString(make([]byte, maxClipboardItemBytes+1))
	if _, err := images.ImportMedia(path, []ClipboardMedia{{Name: "large.png", Data: overLimit}}, false, 0, 0); err == nil {
		t.Fatal("item over 50 MiB accepted")
	}
	for _, item := range []ClipboardMedia{
		{Name: "unsupported.xyz", Data: "YQ=="},
		{Name: "empty.png", Data: ""},
		{Name: "empty-content.png", Data: ""},
		{Name: "bad-padding.png", Data: "YR=="},
	} {
		if _, err := images.ImportMedia(path, []ClipboardMedia{item}, false, 0, 0); err == nil {
			t.Errorf("invalid payload accepted: %+v", item)
		}
	}
	tooMany := make([]ClipboardMedia, maxClipboardItems+1)
	for i := range tooMany {
		tooMany[i] = ClipboardMedia{Name: "item.png", Data: "YQ=="}
	}
	if _, err := images.ImportMedia(path, tooMany, false, 0, 0); err == nil {
		t.Fatal("batch over 100 items accepted")
	}
}
