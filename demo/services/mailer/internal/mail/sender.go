package mail

import (
	"context"
	"fmt"
	"net/smtp"
	"strings"

	"inkwell/mailer/internal/queue"
)

type Sender struct {
	host string
	from string
}

func NewSender(host, from string) *Sender {
	return &Sender{host: host, from: from}
}

func (s *Sender) Deliver(ctx context.Context, job queue.Job) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	message := buildMessage(s.from, job.To, job.Subject, RenderBody(job.Body))
	return smtp.SendMail(s.host, nil, s.from, []string{job.To}, message)
}

func buildMessage(from, to, subject, body string) []byte {
	headers := []string{
		fmt.Sprintf("From: %s", from),
		fmt.Sprintf("To: %s", to),
		fmt.Sprintf("Subject: %s", sanitizeHeader(subject)),
		"MIME-Version: 1.0",
		"Content-Type: text/html; charset=utf-8",
	}
	return []byte(strings.Join(headers, "\r\n") + "\r\n\r\n" + body)
}

func sanitizeHeader(value string) string {
	return strings.NewReplacer("\r", " ", "\n", " ").Replace(value)
}
