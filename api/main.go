package main

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"net/http"
	"time"
	"os"
	"github.com/gorilla/websocket"
	"log"
	"strings"
	"strconv"
)

type Hub struct {
	conns map[string]*websocket.Conn
	reg_chan chan *websocket.Conn
	del_chan chan *websocket.Conn
	write_chan chan []byte
	store *DB
}

func newHub(store *DB) *Hub { // hub constructor
	return &Hub{
		conns: make(map[string]*websocket.Conn),
		reg_chan: make(chan *websocket.Conn),
		del_chan: make(chan *websocket.Conn),
		write_chan: make(chan []byte),
		store: store,
	}
}

func (h *Hub) Register(conn *websocket.Conn){
	pongWait := time.Second * 15
	conn.SetPongHandler(func(appData string) error {
        log.Println("PONG FROM: " + conn.RemoteAddr().String())
        return conn.SetReadDeadline(time.Now().Add(pongWait))
    })

	go func() {
	    ticker := time.NewTicker(pongWait / 2)
	    defer ticker.Stop()
    	for {
            select {
            case <-ticker.C:
                if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
                    log.Println("PING error:", err)
                    h.Delete(conn)
                    return
                }
                    log.Println("PING TO: " + conn.RemoteAddr().String())
            }
    	}
	}()
	h.reg_chan <- conn
}

func (h *Hub) Delete(conn *websocket.Conn){
	h.del_chan <- conn
}

func (h *Hub) Broadcast(message []byte) {
    h.write_chan <- message
}

func (h *Hub) Run() {
	for{
		select{
		case conn := <- h.reg_chan:
			h.conns[conn.RemoteAddr().String()] = conn
			log.Println("REG: " + conn.RemoteAddr().String())

		case conn := <- h.del_chan:
			_, ok := h.conns[conn.RemoteAddr().String()]

			if ok {
				delete(h.conns, conn.RemoteAddr().String())
				conn.Close()
			}

			log.Println("DEL: " + conn.RemoteAddr().String())

		case message := <- h.write_chan:
		    text := string(message)
		    message, err := h.store.Save(text)
			if err != nil {
                log.Println("DB save error:", err)
                continue
            }
			for id, conn := range h.conns{
				err := conn.WriteMessage(websocket.TextMessage, message)
				log.Printf("sending %s to %s", message, id)
				if err != nil {
					log.Println(err)
					delete(h.conns, id)
					conn.Close()
				}
			}

			log.Println("MSG: " + string(message))
		}
	}
}

// token set as a cookie by the web server after basic auth, see web/auth.ts
var authToken string

func authorized(r *http.Request) bool {
	cookie, err := r.Cookie("domat_auth")
	if err != nil {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(cookie.Value), []byte(authToken)) == 1
}

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

func (h *Hub) Serve(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Upgrade") != "websocket" {
        w.WriteHeader(http.StatusOK)
        w.Write([]byte("WebSocket Server is alive!"))
        return
    }

	if !authorized(r) {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("Upgrade error:", err)
		return
	}

	h.Register(conn)

	go func(){
		defer h.Delete(conn)

		for {
			_, message, err := conn.ReadMessage()
			text := string(message)
			if strings.HasPrefix(text, "/") {
			    if strings.HasPrefix(text, "/last") {
                    parts := strings.Split(text, " ")
                    if len(parts) != 2 {
                        conn.WriteMessage(websocket.TextMessage, []byte("#ERROR Usage: /last <page_number>"))
                        continue
                    }
                    page, err := strconv.Atoi(parts[1])
                    if err != nil {
                        conn.WriteMessage(websocket.TextMessage, []byte("#ERROR " + err.Error()))
                        continue
                    }
                    messages, err := h.store.Last(page)
                    if err != nil {
                        conn.WriteMessage(websocket.TextMessage, []byte("#ERROR " + err.Error()))
                        continue
                    }
                    conn.WriteMessage(websocket.TextMessage, []byte(messages))
                    continue
				}
            }
			if err != nil {
				log.Println("Read error:", err)
				break
			}
			h.Broadcast(message)
		}
	}()
}

func main(){
	port := os.Getenv("PORT")
	if port == "" {
		port = "8000"
	}

	password := os.Getenv("PASSWORD")
	if password == "" {
		log.Fatal("PASSWORD env variable is not set, refusing to start")
	}
	sum := sha256.Sum256([]byte("domat:" + password))
	authToken = hex.EncodeToString(sum[:])

	dbPath := os.Getenv("DB_PATH")
	if dbPath == "" {
		dbPath = "/data/domat.db"
	}

	store, err := openDB(dbPath)
	if err != nil {
		log.Fatal("DB open error: ", err)
	}
	_ = store

	hub := newHub(store)
	go hub.Run()

	http.HandleFunc("/", hub.Serve)

	log.Println("READY")

	http.ListenAndServe(":"+port, nil)
}
