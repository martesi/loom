package nativeclipboard

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
)

func Write(paths []string) error {
	data, err := json.Marshal(paths)
	if err != nil {
		return err
	}
	cmd := exec.Command("osascript", "-l", "JavaScript", "-e", `ObjC.import('AppKit'); ObjC.import('stdlib'); const paths = JSON.parse(ObjC.unwrap($.getenv('LOOM_CLIPBOARD_FILES'))); const pb = $.NSPasteboard.generalPasteboard; pb.clearContents; if (!pb.setPropertyListForType($(paths), $('NSFilenamesPboardType'))) throw Error('Cannot write file clipboard');`)
	cmd.Env = append(os.Environ(), "LOOM_CLIPBOARD_FILES="+string(data))
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("native file clipboard: %w: %s", err, out)
	}
	return nil
}
func Read() ([]string, error) {
	cmd := exec.Command("osascript", "-l", "JavaScript", "-e", `ObjC.import('AppKit'); const files = $.NSPasteboard.generalPasteboard.propertyListForType($('NSFilenamesPboardType')); JSON.stringify(files.isNil() ? [] : ObjC.deepUnwrap(files));`)
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
