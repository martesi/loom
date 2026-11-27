//go:build !server

package service

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestWindowsNativeClipboardPaste(t *testing.T) {
	// This overwrites the system clipboard, so opt in only on a disposable runner.
	if os.Getenv("LOOM_TEST_NATIVE_CLIPBOARD") != "1" {
		t.Skip("set LOOM_TEST_NATIVE_CLIPBOARD=1 on a disposable Windows runner")
	}
	for _, tc := range []struct {
		name   string
		effect uint32
		moves  bool
	}{
		{name: "cut", effect: 2, moves: true},
		{name: "copy", effect: 1},
		{name: "missing-effect"},
		{name: "ambiguous-effect", effect: 3},
	} {
		t.Run(tc.name, func(t *testing.T) {
			const media = "移动 sample.png"
			const ignored = "keep.txt"
			repoPath, sources := makeImportModeFixture(t, t.TempDir(), media, ignored)
			writeWindowsPasteClipboard(t, sources, tc.effect)

			ids, err := (&ImageService{}).PasteNativeFiles(repoPath, false, 0, 0)
			if err != nil || len(ids) != 1 {
				t.Fatalf("expected one media import, got ids=%v err=%v", ids, err)
			}
			target := filepath.Join(repoPath, media)
			expectImportBytes(t, target, media)
			expectAbsentImport(t, filepath.Join(repoPath, ignored))
			expectImportBytes(t, sources[1], ignored)
			if tc.moves {
				expectAbsentImport(t, sources[0])
			} else {
				expectImportBytes(t, sources[0], media)
			}

			assertImportHistory(t, repoPath, false)
			expectAbsentImport(t, target)
			expectImportBytes(t, sources[0], media)
			expectImportBytes(t, sources[1], ignored)
		})
	}
}

func writeWindowsPasteClipboard(t *testing.T, paths []string, effect uint32) {
	t.Helper()
	input, err := json.Marshal(struct {
		Paths  []string `json:"paths"`
		Effect uint32   `json:"effect"`
	}{Paths: paths, Effect: effect})
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-STA", "-Command", `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
[Console]::InputEncoding = [Text.Encoding]::UTF8
$item = [Console]::In.ReadToEnd() | ConvertFrom-Json
$data = New-Object System.Windows.Forms.DataObject
$data.SetData([System.Windows.Forms.DataFormats]::FileDrop, $false, [string[]]$item.paths)
if ($item.effect -ne 0) {
    $bytes = [BitConverter]::GetBytes([uint32]$item.effect)
    $stream = [System.IO.MemoryStream]::new($bytes)
    $data.SetData('Preferred DropEffect', $false, $stream)
}
[System.Windows.Forms.Clipboard]::SetDataObject($data, $true, 10, 100)
`)
	cmd.Stdin = strings.NewReader(string(input))
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("populate Windows clipboard: %v: %s", err, out)
	}
}
