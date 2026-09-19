package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"inkwell/mailer/internal/mail"
	"inkwell/mailer/internal/queue"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	sender := mail.NewSender(envOr("SMTP_HOST", "localhost:1025"), envOr("MAIL_FROM", "hello@inkwell.example"))
	consumer := queue.NewConsumer(envOr("REDIS_URL", "redis://localhost:6379"), "mail:outbox")

	log.Println("mailer: waiting for jobs")
	if err := consumer.Run(ctx, 2*time.Second, sender.Deliver); err != nil {
		log.Fatalf("mailer: %v", err)
	}
}

func envOr(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
