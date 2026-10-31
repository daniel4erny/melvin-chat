package main

import (
	"database/sql"
	_ "modernc.org/sqlite"
	"time"
	"encoding/json"
)

type DB struct {
	sql *sql.DB
}

type Message struct {
    ID        int
    Text      string
    CreatedAt time.Time
}

func openDB(path string) (*DB, error) {
	conn, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}

	_, err = conn.Exec(`CREATE TABLE IF NOT EXISTS messages (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		text TEXT NOT NULL,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP
	)`)
	if err != nil {
		return nil, err
	}

	return &DB{sql: conn}, nil
}

func (d *DB) Save(text string) ([]byte, error) {
        var m Message
        err := d.sql.QueryRow(
                "INSERT INTO messages (text) VALUES (?) RETURNING id, text, created_at", text,
        ).Scan(&m.ID, &m.Text, &m.CreatedAt)
        if err != nil {
                return nil, err
        }

        jsonData, err := json.Marshal(m)
        if err != nil {
                return nil, err
        }

        return jsonData, nil
}

func (d *DB) Last(page int) (string, error) {
	n := 50
	offset := page * n
	messages := []Message{}
    rows, err := d.sql.Query("SELECT id, text, created_at FROM messages ORDER BY created_at DESC LIMIT ? OFFSET ?", n, offset)
    if err != nil {
        return "", err
    }
    defer rows.Close()

    for rows.Next() {
        var id int
        var text string
        var createdAt time.Time

        if err := rows.Scan(&id, &text, &createdAt); err != nil {
            return "", err
        }
        currentMessage := Message{
            ID: id,
            Text: text,
            CreatedAt: createdAt,
        }
        messages = append(messages, currentMessage)
    }

    if err := rows.Err(); err != nil {
        return "", err
    }

    res := make([]string, len(messages))
    for i, message := range messages {
        jsonData, err := json.Marshal(message)
        if err != nil {
            return "", err
        }
        res[i] = string(jsonData)
    }

    jsonData, err := json.Marshal(messages)
    if err != nil {
            return "", err
    }
    return string(jsonData), nil
}
