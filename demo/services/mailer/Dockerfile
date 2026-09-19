FROM golang:1.22 AS build
WORKDIR /src
COPY go.mod ./
COPY . .
RUN CGO_ENABLED=0 go build -o /mailer .

FROM gcr.io/distroless/static
COPY --from=build /mailer /mailer
ENTRYPOINT ["/mailer"]
