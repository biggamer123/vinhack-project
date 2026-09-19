package queue

import (
	"context"
	"encoding/json"
	"errors"
	"time"
)

type Job struct {
	To       string `json:"to"`
	Subject  string `json:"subject"`
	Body     string `json:"body"`
	Attempts int    `json:"attempts"`
}

type Handler func(ctx context.Context, job Job) error

type Consumer struct {
	url     string
	key     string
	pending [][]byte
}

const maxAttempts = 5

func NewConsumer(url, key string) *Consumer {
	return &Consumer{url: url, key: key}
}

func (c *Consumer) Run(ctx context.Context, poll time.Duration, handle Handler) error {
	ticker := time.NewTicker(poll)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			if err := c.drain(ctx, handle); err != nil {
				return err
			}
		}
	}
}

func (c *Consumer) drain(ctx context.Context, handle Handler) error {
	for len(c.pending) > 0 {
		raw := c.pending[0]
		c.pending = c.pending[1:]
		job, err := decodeJob(raw)
		if err != nil {
			continue
		}
		if err := handle(ctx, job); err != nil {
			c.retry(job)
		}
	}
	return nil
}

func (c *Consumer) retry(job Job) {
	job.Attempts++
	if job.Attempts >= maxAttempts {
		return
	}
	raw, _ := json.Marshal(job)
	c.pending = append(c.pending, raw)
}

func decodeJob(raw []byte) (Job, error) {
	var job Job
	if err := json.Unmarshal(raw, &job); err != nil {
		return job, err
	}
	if job.To == "" {
		return job, errors.New("job without recipient")
	}
	return job, nil
}
