package service

import "loom/internal/store"

// PromptService backs the manual prompt attach/reuse picker (docs/init.md
// Stage 1: "browse-and-pick list over the managed prompt library... backed
// by FindOrCreate-by-hash so picking and dedup don't fight"). Prompt
// automation from generation tooling is explicitly out of scope — every
// prompt in the library got there because a user typed or picked one.
type PromptService struct{}

type PromptInfo struct {
	ID         int64  `json:"id"`
	Name       string `json:"name"`
	Text       string `json:"text"`
	Negative   string `json:"negative"`
	UsageCount int    `json:"usageCount"`
}

func toPromptInfo(p store.PromptWithUsage) PromptInfo {
	return PromptInfo{
		ID:         p.ID,
		Name:       p.Name,
		Text:       p.Text,
		Negative:   p.Negative,
		UsageCount: p.UsageCount,
	}
}

// ListPrompts returns the whole managed prompt library for the picker's
// browse list.
func (s *PromptService) ListPrompts(repoPath string) ([]PromptInfo, error) {
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		return nil, err
	}
	defer repo.Close()

	prompts, err := repo.ListPrompts()
	if err != nil {
		return nil, err
	}
	out := make([]PromptInfo, len(prompts))
	for i, p := range prompts {
		out[i] = toPromptInfo(p)
	}
	return out, nil
}

// attachPrompt is the shared core of AttachPrompt/CreateAndAttachPrompt:
// read the image's current prompt (for the undo inverse), point it at
// promptID, and log the step. Mirrors GroupService.SetCover's
// read-before-write shape.
func attachPrompt(repo *store.Repo, imageID, promptID int64) error {
	prev, err := repo.GetImagePromptID(imageID)
	if err != nil {
		return err
	}
	if prev != nil && *prev == promptID {
		return nil // already attached — no-op, nothing to log
	}
	if err := repo.SetImagePrompt(imageID, &promptID); err != nil {
		return err
	}
	fwd := promptStepPayload{ImageID: imageID, PromptID: promptID, HasPrompt: true}
	inv := promptStepPayload{ImageID: imageID, HasPrompt: false}
	if prev != nil {
		inv.PromptID = *prev
		inv.HasPrompt = true
	}
	return recordOp(repo, stepSetPrompt, step(stepSetPrompt, fwd), step(stepSetPrompt, inv))
}

// AttachPrompt points imageID at an existing prompt from the library
// (the "reuse" half of the picker).
func (s *PromptService) AttachPrompt(repoPath string, imageID, promptID int64) error {
	repo, unlock, err := openOperationRepo(repoPath)
	if err != nil {
		return err
	}
	defer unlock()
	defer repo.Close()

	return attachPrompt(repo, imageID, promptID)
}

// CreateAndAttachPrompt finds-or-creates a prompt by text+negative (dedup
// key) and attaches it to imageID — the "manual attach" half of the
// picker, for a prompt that isn't in the library yet.
func (s *PromptService) CreateAndAttachPrompt(repoPath string, imageID int64, name, text, negative string) (*PromptInfo, error) {
	repo, unlock, err := openOperationRepo(repoPath)
	if err != nil {
		return nil, err
	}
	defer unlock()
	defer repo.Close()

	promptID, err := repo.FindOrCreatePrompt(name, text, negative)
	if err != nil {
		return nil, err
	}
	if err := attachPrompt(repo, imageID, promptID); err != nil {
		return nil, err
	}
	return &PromptInfo{ID: promptID, Name: name, Text: text, Negative: negative}, nil
}

// DetachPrompt clears whatever prompt imageID has attached, if any.
func (s *PromptService) DetachPrompt(repoPath string, imageID int64) error {
	repo, unlock, err := openOperationRepo(repoPath)
	if err != nil {
		return err
	}
	defer unlock()
	defer repo.Close()

	prev, err := repo.GetImagePromptID(imageID)
	if err != nil {
		return err
	}
	if prev == nil {
		return nil // no-op — nothing attached to detach
	}
	if err := repo.SetImagePrompt(imageID, nil); err != nil {
		return err
	}
	fwd := promptStepPayload{ImageID: imageID, HasPrompt: false}
	inv := promptStepPayload{ImageID: imageID, PromptID: *prev, HasPrompt: true}
	return recordOp(repo, stepSetPrompt, step(stepSetPrompt, fwd), step(stepSetPrompt, inv))
}
