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
	repo, unlock, err := openOperationRepo(repoPath)
	if err != nil {
		return nil, err
	}
	defer unlock()
	defer repo.Close()

	tagID, err := repo.FindOrCreateTag(tagName)
	if err != nil {
		return nil, err
	}
	added, err := repo.AddImageTag(imageID, tagID)
	if err != nil {
		return nil, err
	}
	// Already-tagged is a no-op — don't log an undo step whose inverse
	// would strip a tag this call didn't attach.
	if added {
		p := tagStepPayload{ImageID: imageID, TagID: tagID}
		if err := recordOp(repo, stepTagAdd, step(stepTagAdd, p), step(stepTagRemove, p)); err != nil {
			return nil, err
		}
	}
	return &TagInfo{ID: tagID, Name: tagName}, nil
}

func (s *TagService) RemoveTag(repoPath string, imageID, tagID int64) error {
	repo, unlock, err := openOperationRepo(repoPath)
	if err != nil {
		return err
	}
	defer unlock()
	defer repo.Close()

	removed, err := repo.RemoveImageTag(imageID, tagID)
	if err != nil {
		return err
	}
	if !removed {
		return nil
	}
	p := tagStepPayload{ImageID: imageID, TagID: tagID}
	return recordOp(repo, stepTagRemove, step(stepTagRemove, p), step(stepTagAdd, p))
}
