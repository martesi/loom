package service

import "loom/internal/store"

type TagService struct{}

type TagInfo struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
}

func (s *TagService) ListTags(repoPath string) ([]TagInfo, error) {
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		return nil, err
	}
	defer repo.Close()

	tags, err := repo.ListTags()
	if err != nil {
		return nil, err
	}
	out := make([]TagInfo, len(tags))
	for i, t := range tags {
		out[i] = TagInfo{ID: t.ID, Name: t.Name}
	}
	return out, nil
}

func (s *TagService) TagsForImage(repoPath string, imageID int64) ([]TagInfo, error) {
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		return nil, err
	}
	defer repo.Close()

	tags, err := repo.TagsForImage(imageID)
	if err != nil {
		return nil, err
	}
	out := make([]TagInfo, len(tags))
	for i, t := range tags {
		out[i] = TagInfo{ID: t.ID, Name: t.Name}
	}
	return out, nil
}

// AddTag attaches tagName to imageID, creating the tag (free-form, no
// managed taxonomy — see data model docs) if this is the first time it's
// been used.
func (s *TagService) AddTag(repoPath string, imageID int64, tagName string) (*TagInfo, error) {
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		return nil, err
	}
	defer repo.Close()

	tagID, err := repo.FindOrCreateTag(tagName)
	if err != nil {
		return nil, err
	}
	if err := repo.AddImageTag(imageID, tagID); err != nil {
		return nil, err
	}
	p := tagStepPayload{ImageID: imageID, TagID: tagID}
	if err := recordOp(repo, stepTagAdd, step(stepTagAdd, p), step(stepTagRemove, p)); err != nil {
		return nil, err
	}
	return &TagInfo{ID: tagID, Name: tagName}, nil
}

func (s *TagService) RemoveTag(repoPath string, imageID, tagID int64) error {
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		return err
	}
	defer repo.Close()

	if err := repo.RemoveImageTag(imageID, tagID); err != nil {
		return err
	}
	p := tagStepPayload{ImageID: imageID, TagID: tagID}
	return recordOp(repo, stepTagRemove, step(stepTagRemove, p), step(stepTagAdd, p))
}
