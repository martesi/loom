package service

import (
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"sync"
	"testing"
	"time"

	"loom/internal/media"
)

func TestFullAndCopyReadersWaitForEachReplacementPhase(t *testing.T) {
	phases := []struct {
		name  string
		fault string
		crash string
	}{
		{name: "before-current-move", fault: "before-current-move"},
		{name: "after-current-move", crash: "after-current-move"},
		{name: "before-incoming-move", fault: "before-incoming-move"},
		{name: "after-incoming-move", crash: "after-incoming-move"},
		{name: "before-final-transaction", fault: "before-final-transaction"},
	}
	for _, phase := range phases {
		t.Run(phase.name, func(t *testing.T) {
			root, imageID := seedReplacementJournalRepo(t, "original bytes")
			entered := make(chan struct{})
			release := make(chan struct{})
			var once sync.Once
			var releaseOnce sync.Once
			unblock := func() { releaseOnce.Do(func() { close(release) }) }
			block := func(point string) {
				matches := phase.fault != "" && point == phase.fault || phase.crash != "" && point == phase.crash
				if matches {
					once.Do(func() { close(entered) })
					<-release
				}
			}
			if phase.fault != "" {
				replacementJournalFaultHook = func(point string) error { block(point); return nil }
			} else {
				replacementJournalCrashHook = block
			}
			replacementDone := make(chan error, 1)
			go func() {
				result, err := (&ImageService{}).ReplaceMedia(root, imageID, ClipboardMedia{
					Name: "replacement.png", Data: base64.StdEncoding.EncodeToString([]byte("replacement bytes")),
				}, "reader-fence-"+phase.name)
				if err == nil && (result == nil || !result.Applied) {
					err = fmt.Errorf("replacement did not complete: %+v", result)
				}
				replacementDone <- err
			}()
			select {
			case <-entered:
			case <-time.After(5 * time.Second):
				unblock()
				t.Fatal("replacement did not reach the requested phase")
			}
			defer func() {
				unblock()
				replacementJournalFaultHook = nil
				replacementJournalCrashHook = nil
			}()

			const readers = 4
			started := make(chan struct{}, readers)
			done := make(chan error, readers)
			for index := 0; index < readers; index++ {
				go func(index int) {
					started <- struct{}{}
					switch index {
					case 0, 1, 2:
						method := []string{http.MethodGet, http.MethodHead, http.MethodGet}[index]
						request := httptest.NewRequest(method, fullURL(root, imageID), nil)
						if index == 2 {
							request.Header.Set("Range", "bytes=0-4")
						}
						response := httptest.NewRecorder()
						ServeFull(response, request)
						if index == 0 && (response.Code != http.StatusOK || response.Body.String() != "replacement bytes") {
							done <- fmt.Errorf("full GET status=%d bytes=%q", response.Code, response.Body.String())
							return
						}
						if index == 1 && (response.Code != http.StatusOK || response.Body.Len() != 0) {
							done <- fmt.Errorf("full HEAD status=%d body=%q", response.Code, response.Body.String())
							return
						}
						if index == 2 && (response.Code != http.StatusPartialContent || response.Body.String() != "repla") {
							done <- fmt.Errorf("full range status=%d bytes=%q", response.Code, response.Body.String())
							return
						}
						done <- nil
					default:
						copied, err := (&ImageService{}).CopyMedia(root, []int64{imageID}, false)
						if err == nil && (len(copied) != 1 || copied[0].Data != base64.StdEncoding.EncodeToString([]byte("replacement bytes"))) {
							err = fmt.Errorf("copy returned unexpected bytes: %+v", copied)
						}
						done <- err
					}
				}(index)
			}
			for range readers {
				<-started
			}
			select {
			case err := <-done:
				t.Fatalf("reader completed against an intermediate swap layout: %v", err)
			case <-time.After(40 * time.Millisecond):
			}
			unblock()
			if err := <-replacementDone; err != nil {
				t.Fatal(err)
			}
			for range readers {
				select {
				case err := <-done:
					if err != nil {
						t.Fatal(err)
					}
				case <-time.After(5 * time.Second):
					t.Fatal("source reader remained blocked after replacement completed")
				}
			}
		})
	}
}

func TestReplacementWaitsUntilFullResponseFinishes(t *testing.T) {
	root, imageID := seedReplacementJournalRepo(t, "original bytes")
	started := make(chan struct{})
	release := make(chan struct{})
	response := &blockingFullResponse{header: make(http.Header), started: started, release: release}
	fullDone := make(chan struct{})
	go func() {
		ServeFull(response, httptest.NewRequest(http.MethodGet, fullURL(root, imageID), nil))
		close(fullDone)
	}()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("full response did not begin streaming")
	}
	replacementDone := make(chan error, 1)
	go func() {
		result, err := (&ImageService{}).ReplaceMedia(root, imageID, ClipboardMedia{
			Name: "replacement.png", Data: base64.StdEncoding.EncodeToString([]byte("replacement bytes")),
		}, "full-response-lock-request")
		if err == nil && (result == nil || !result.Applied) {
			err = fmt.Errorf("replacement did not complete: %+v", result)
		}
		replacementDone <- err
	}()
	select {
	case err := <-replacementDone:
		t.Fatalf("replacement passed an active full response lease: %v", err)
	case <-time.After(40 * time.Millisecond):
	}
	close(release)
	select {
	case <-fullDone:
	case <-time.After(5 * time.Second):
		t.Fatal("full response did not finish")
	}
	if got := response.body.String(); got != "original bytes" {
		t.Fatalf("full response mixed replacement bytes: %q", got)
	}
	if err := <-replacementDone; err != nil {
		t.Fatal(err)
	}
}

func TestReplacementWaitsUntilTranscodeFinishesReadingSource(t *testing.T) {
	root, imageID := seedReplacementJournalRepo(t, "original bytes")
	processor := &blockingTranscodeProcessor{started: make(chan struct{}), release: make(chan struct{})}
	transcodeDone := make(chan *ClipboardMedia, 1)
	transcodeErr := make(chan error, 1)
	go func() {
		result, err := (&MediaService{Processor: processor}).Transcode(root, imageID, MediaTranscodeRequest{TargetExt: ".webp"})
		transcodeDone <- result
		transcodeErr <- err
	}()
	select {
	case <-processor.started:
	case <-time.After(5 * time.Second):
		t.Fatal("transcode did not open the source")
	}
	replacementDone := make(chan error, 1)
	go func() {
		result, err := (&ImageService{}).ReplaceMedia(root, imageID, ClipboardMedia{
			Name: "replacement.png", Data: base64.StdEncoding.EncodeToString([]byte("replacement bytes")),
		}, "transcode-source-lock-request")
		if err == nil && (result == nil || !result.Applied) {
			err = fmt.Errorf("replacement did not complete: %+v", result)
		}
		replacementDone <- err
	}()
	select {
	case err := <-replacementDone:
		t.Fatalf("replacement passed an active transcode source lease: %v", err)
	case <-time.After(40 * time.Millisecond):
	}
	close(processor.release)
	result := <-transcodeDone
	if err := <-transcodeErr; err != nil || result == nil || result.Data != base64.StdEncoding.EncodeToString([]byte("original bytes")) {
		t.Fatalf("transcode read mixed/stale source bytes: result=%+v err=%v", result, err)
	}
	if err := <-replacementDone; err != nil {
		t.Fatal(err)
	}
}

func TestReplacementWaitsUntilPreviewFinishesReadingSource(t *testing.T) {
	root, imageID, _ := previewTestAsset(t)
	url := previewTestURL(t, root, imageID, 640)
	started := make(chan struct{})
	release := make(chan struct{})
	processor := &previewTestProcessor{onPreview: func(source, destination string, _ int) error {
		close(started)
		<-release
		data, err := os.ReadFile(source)
		if err != nil {
			return err
		}
		return os.WriteFile(destination, append([]byte("encoded:"), data...), 0o600)
	}}
	response := httptest.NewRecorder()
	previewDone := make(chan struct{})
	go func() {
		ServePreviewWithProcessor(response, httptest.NewRequest(http.MethodGet, url, nil), processor)
		close(previewDone)
	}()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("preview did not begin reading its source")
	}
	replacementDone := make(chan error, 1)
	go func() {
		result, err := (&ImageService{}).ReplaceMedia(root, imageID, ClipboardMedia{
			Name: "replacement.png", Data: base64.StdEncoding.EncodeToString([]byte("replacement bytes")),
		}, "preview-source-lock-request")
		if err == nil && (result == nil || !result.Applied) {
			err = fmt.Errorf("replacement did not complete: %+v", result)
		}
		replacementDone <- err
	}()
	select {
	case err := <-replacementDone:
		t.Fatalf("replacement passed an active preview source lease: %v", err)
	case <-time.After(40 * time.Millisecond):
	}
	close(release)
	select {
	case <-previewDone:
	case <-time.After(5 * time.Second):
		t.Fatal("preview did not finish")
	}
	if response.Code != http.StatusOK || response.Body.String() != "encoded:original source bytes" {
		t.Fatalf("preview returned mixed source bytes: status=%d body=%q", response.Code, response.Body.String())
	}
	if err := <-replacementDone; err != nil {
		t.Fatal(err)
	}
}

type blockingFullResponse struct {
	header  http.Header
	started chan struct{}
	release chan struct{}
	body    bytes.Buffer
	once    sync.Once
	status  int
}

type blockingTranscodeProcessor struct {
	started chan struct{}
	release chan struct{}
}

func (processor *blockingTranscodeProcessor) Thumbnail(string, string, bool) (media.Dimensions, error) {
	return media.Dimensions{}, nil
}

func (processor *blockingTranscodeProcessor) Preview(context.Context, string, string, int, bool) error {
	return nil
}

func (processor *blockingTranscodeProcessor) Transcode(source, destination string, _ media.TranscodeOptions) error {
	close(processor.started)
	<-processor.release
	data, err := os.ReadFile(source)
	if err != nil {
		return err
	}
	return os.WriteFile(destination, data, 0o600)
}

func (response *blockingFullResponse) Header() http.Header    { return response.header }
func (response *blockingFullResponse) WriteHeader(status int) { response.status = status }
func (response *blockingFullResponse) Write(data []byte) (int, error) {
	response.once.Do(func() {
		close(response.started)
		<-response.release
	})
	return response.body.Write(data)
}
