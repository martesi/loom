package nativeclipboard

import (
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
)

func Write(paths []string) error {
	data, err := json.Marshal(paths)
	if err != nil {
		return err
	}
	cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-STA", "-Command", `Add-Type -AssemblyName System.Windows.Forms; $files = New-Object System.Collections.Specialized.StringCollection; $paths = [Console]::In.ReadToEnd() | ConvertFrom-Json; foreach ($p in $paths) { [void]$files.Add($p) }; [System.Windows.Forms.Clipboard]::SetFileDropList($files)`)
	cmd.Stdin = strings.NewReader(string(data))
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("native file clipboard: %w: %s", err, out)
	}
	return nil
}
func Read() ([]string, error) {
	cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-STA", "-Command", `Add-Type -AssemblyName System.Windows.Forms; ConvertTo-Json -Compress -InputObject @([System.Windows.Forms.Clipboard]::GetFileDropList())`)
	out, err := cmd.Output()
	if err != nil {
		return nil, err
	}
	var paths []string
	if err := json.Unmarshal(out, &paths); err != nil {
		return nil, err
	}
	return paths, nil
}
