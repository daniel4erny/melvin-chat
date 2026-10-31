package main

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

type Hub struct {
	mu      sync.RWMutex
	clients map[*Client]struct{}
	byUser  map[int64]map[*Client]struct{}
	calls   map[int64]map[int64]int
	db      *DB
}

type Client struct {
	hub      *Hub
	conn     *websocket.Conn
	user     User
	send     chan []byte
	mu       sync.Mutex
	channels map[int64]bool
	calls    map[int64]bool
	visible  bool
	closed   bool
}

func newHub(db *DB) *Hub {
	return &Hub{
		clients: map[*Client]struct{}{},
		byUser:  map[int64]map[*Client]struct{}{},
		calls:   map[int64]map[int64]int{},
		db:      db,
	}
}

var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	CheckOrigin:     func(r *http.Request) bool { return true },
}

func (h *Hub) ServeWS(w http.ResponseWriter, r *http.Request) {
	if !websocket.IsWebSocketUpgrade(r) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("Melvin WebSocket is alive"))
		return
	}
	token := ""
	if t := r.URL.Query().Get("token"); t != "" {
		token = t
	} else if auth := r.Header.Get("Authorization"); strings.HasPrefix(auth, "Bearer ") {
		token = strings.TrimPrefix(auth, "Bearer ")
	} else if c, err := r.Cookie("melvin_session"); err == nil {
		token = c.Value
	}
	if token == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	u, err := h.db.SessionUser(hashToken(token))
	if err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("ws upgrade:", err)
		return
	}
	c := &Client{
		hub:      h,
		conn:     conn,
		user:     u,
		send:     make(chan []byte, 128),
		channels: map[int64]bool{},
		calls:    map[int64]bool{},
		visible:  u.Settings.Presence != "nobody",
	}
	h.add(c)

	go c.writePump()
	c.readPump()
	h.remove(c)
}

func (h *Hub) add(c *Client) {
	h.mu.Lock()
	first := len(h.byUser[c.user.ID]) == 0
	h.clients[c] = struct{}{}
	if h.byUser[c.user.ID] == nil {
		h.byUser[c.user.ID] = map[*Client]struct{}{}
	}
	h.byUser[c.user.ID][c] = struct{}{}
	online := h.onlineSetLocked()
	h.mu.Unlock()

	c.enqueue(map[string]any{"type": "hello", "online": online, "user": c.user})
	if first && c.visible {
		h.broadcastAll(map[string]any{"type": "presence", "userId": c.user.ID, "online": true})
	}
}

func (h *Hub) remove(c *Client) {
	h.mu.Lock()
	if _, ok := h.clients[c]; !ok {
		h.mu.Unlock()
		return
	}
	delete(h.clients, c)
	if set := h.byUser[c.user.ID]; set != nil {
		delete(set, c)
		if len(set) == 0 {
			delete(h.byUser, c.user.ID)
		}
	}
	stillOnline := len(h.byUser[c.user.ID]) > 0
	callChannels := []int64{}
	c.mu.Lock()
	for ch := range c.calls {
		callChannels = append(callChannels, ch)
		c.calls[ch] = false
	}
	c.closed = true
	c.mu.Unlock()
	h.mu.Unlock()

	_ = c.conn.Close()

	for _, ch := range callChannels {
		h.leaveCall(c, ch)
	}
	if !stillOnline && c.visible {
		h.broadcastAll(map[string]any{"type": "presence", "userId": c.user.ID, "online": false})
	}
}

func (h *Hub) onlineSetLocked() []int64 {
	ids := []int64{}
	for uid, set := range h.byUser {
		if len(set) == 0 {
			continue
		}
		for c := range set {
			if c.visible {
				ids = append(ids, uid)
				break
			}
		}
	}
	return ids
}

func (h *Hub) onlineSet() map[int64]bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	out := map[int64]bool{}
	for _, id := range h.onlineSetLocked() {
		out[id] = true
	}
	return out
}

func (h *Hub) setPresence(userID int64, visible bool) {
	h.mu.Lock()
	for c := range h.byUser[userID] {
		c.visible = visible
	}
	online := len(h.byUser[userID]) > 0
	h.mu.Unlock()
	h.broadcastAll(map[string]any{"type": "presence", "userId": userID, "online": visible && online})
}

func (c *Client) enqueue(payload any) {
	data, err := json.Marshal(payload)
	if err != nil {
		return
	}
	c.mu.Lock()
	closed := c.closed
	c.mu.Unlock()
	if closed {
		return
	}
	select {
	case c.send <- data:
	default:
		// slow client, drop it rather than block the whole hub
		c.hub.remove(c)
	}
}

func (h *Hub) broadcastAll(payload any) {
	data, err := json.Marshal(payload)
	if err != nil {
		return
	}
	h.mu.RLock()
	clients := make([]*Client, 0, len(h.clients))
	for c := range h.clients {
		clients = append(clients, c)
	}
	h.mu.RUnlock()
	for _, c := range clients {
		c.enqueueRaw(data)
	}
}

func (h *Hub) BroadcastChannel(channelID int64, payload any) {
	data, err := json.Marshal(payload)
	if err != nil {
		return
	}
	h.mu.RLock()
	clients := []*Client{}
	for c := range h.clients {
		c.mu.Lock()
		subscribed := c.channels[channelID]
		c.mu.Unlock()
		if subscribed {
			clients = append(clients, c)
		}
	}
	h.mu.RUnlock()
	for _, c := range clients {
		c.enqueueRaw(data)
	}
}

func (h *Hub) BroadcastUsers(userIDs []int64, payload any) {
	data, err := json.Marshal(payload)
	if err != nil {
		return
	}
	seen := map[*Client]bool{}
	h.mu.RLock()
	for _, uid := range userIDs {
		for c := range h.byUser[uid] {
			seen[c] = true
		}
	}
	h.mu.RUnlock()
	for c := range seen {
		c.enqueueRaw(data)
	}
}

func (h *Hub) sendToUser(userID int64, payload any, except *Client) {
	data, err := json.Marshal(payload)
	if err != nil {
		return
	}
	h.mu.RLock()
	clients := []*Client{}
	for c := range h.byUser[userID] {
		if c != except {
			clients = append(clients, c)
		}
	}
	h.mu.RUnlock()
	for _, c := range clients {
		c.enqueueRaw(data)
	}
}

func (c *Client) enqueueRaw(data []byte) {
	c.mu.Lock()
	closed := c.closed
	c.mu.Unlock()
	if closed {
		return
	}
	select {
	case c.send <- data:
	default:
		c.hub.remove(c)
	}
}

func (c *Client) writePump() {
	ticker := time.NewTicker(25 * time.Second)
	defer func() {
		ticker.Stop()
		_ = c.conn.Close()
	}()
	for {
		select {
		case msg, ok := <-c.send:
			_ = c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if !ok {
				_ = c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := c.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				return
			}
		case <-ticker.C:
			_ = c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

type wsEvent struct {
	Type        string          `json:"type"`
	ChannelIDs  []int64         `json:"channelIds"`
	ChannelID   int64           `json:"channelId"`
	To          int64           `json:"to"`
	SDP         json.RawMessage `json:"sdp"`
	Candidate   json.RawMessage `json:"candidate"`
	Renegotiate bool            `json:"renegotiate"`
}

func (c *Client) readPump() {
	c.conn.SetReadLimit(256 * 1024)
	_ = c.conn.SetReadDeadline(time.Now().Add(70 * time.Second))
	c.conn.SetPongHandler(func(string) error {
		return c.conn.SetReadDeadline(time.Now().Add(70 * time.Second))
	})
	for {
		_, data, err := c.conn.ReadMessage()
		if err != nil {
			return
		}
		var ev wsEvent
		if err := json.Unmarshal(data, &ev); err != nil {
			continue
		}
		switch ev.Type {
		case "subscribe":
			c.subscribe(ev.ChannelIDs)
		case "typing":
			c.typing(ev.ChannelID)
		case "call:join":
			c.hub.joinCall(c, ev.ChannelID)
		case "call:leave":
			c.hub.leaveCall(c, ev.ChannelID)
		case "call:offer", "call:answer", "call:ice":
			c.relaySignal(ev)
		}
	}
}

func (c *Client) subscribe(ids []int64) {
	for _, id := range ids {
		_, member, _ := c.hub.db.MemberRole(id, c.user.ID)
		if !member {
			continue
		}
		c.mu.Lock()
		c.channels[id] = true
		c.mu.Unlock()
	}
}

func (c *Client) typing(channelID int64) {
	if _, member, _ := c.hub.db.MemberRole(channelID, c.user.ID); !member {
		return
	}
	c.hub.BroadcastChannel(channelID, map[string]any{
		"type":      "typing",
		"channelId": channelID,
		"user": map[string]any{
			"id": c.user.ID, "displayName": c.user.DisplayName, "username": c.user.Username,
		},
	})
}

func (h *Hub) joinCall(c *Client, channelID int64) {
	if channelID == 0 {
		return
	}
	if _, member, _ := h.db.MemberRole(channelID, c.user.ID); !member {
		return
	}
	h.mu.Lock()
	if h.calls[channelID] == nil {
		h.calls[channelID] = map[int64]int{}
	}
	already := h.calls[channelID][c.user.ID] > 0
	h.calls[channelID][c.user.ID]++
	participants := []int64{}
	for uid := range h.calls[channelID] {
		if uid != c.user.ID {
			participants = append(participants, uid)
		}
	}
	h.mu.Unlock()

	c.mu.Lock()
	c.calls[channelID] = true
	c.mu.Unlock()

	users := []map[string]any{}
	for _, uid := range participants {
		if u, err := h.db.UserByID(uid); err == nil {
			users = append(users, map[string]any{
				"id": u.ID, "username": u.Username, "displayName": u.DisplayName, "avatarColor": u.AvatarColor,
			})
		}
	}
	c.enqueue(map[string]any{"type": "call:participants", "channelId": channelID, "participants": users})
	if !already {
		h.BroadcastChannel(channelID, map[string]any{
			"type": "call:peer-joined", "channelId": channelID,
			"user": map[string]any{
				"id": c.user.ID, "username": c.user.Username,
				"displayName": c.user.DisplayName, "avatarColor": c.user.AvatarColor,
			},
		})
		h.BroadcastChannel(channelID, map[string]any{
			"type": "call:ring", "channelId": channelID,
			"from": map[string]any{
				"id": c.user.ID, "username": c.user.Username,
				"displayName": c.user.DisplayName, "avatarColor": c.user.AvatarColor,
			},
		})
	}
}

func (h *Hub) leaveCall(c *Client, channelID int64) {
	c.mu.Lock()
	wasIn := c.calls[channelID]
	delete(c.calls, channelID)
	c.mu.Unlock()
	if !wasIn {
		return
	}
	h.mu.Lock()
	left := false
	if call := h.calls[channelID]; call != nil {
		call[c.user.ID]--
		if call[c.user.ID] <= 0 {
			delete(call, c.user.ID)
			left = true
		}
		if len(call) == 0 {
			delete(h.calls, channelID)
		}
	}
	h.mu.Unlock()
	if left {
		h.BroadcastChannel(channelID, map[string]any{
			"type": "call:peer-left", "channelId": channelID, "userId": c.user.ID,
		})
	}
}

func (c *Client) relaySignal(ev wsEvent) {
	if ev.ChannelID == 0 || ev.To == 0 || ev.To == c.user.ID {
		return
	}
	if _, member, _ := c.hub.db.MemberRole(ev.ChannelID, c.user.ID); !member {
		return
	}
	if _, member, _ := c.hub.db.MemberRole(ev.ChannelID, ev.To); !member {
		return
	}
	payload := map[string]any{
		"type":      ev.Type,
		"channelId": ev.ChannelID,
		"from": map[string]any{
			"id": c.user.ID, "username": c.user.Username,
			"displayName": c.user.DisplayName, "avatarColor": c.user.AvatarColor,
		},
		"renegotiate": ev.Renegotiate,
	}
	if len(ev.SDP) > 0 {
		payload["sdp"] = ev.SDP
	}
	if len(ev.Candidate) > 0 {
		payload["candidate"] = ev.Candidate
	}
	c.hub.sendToUser(ev.To, payload, c)
}
