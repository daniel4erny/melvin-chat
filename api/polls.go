package main

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
)

type PollOption struct {
	ID    int64  `json:"id"`
	Text  string `json:"text"`
	Votes int    `json:"votes"`
}

type Poll struct {
	ID         int64        `json:"id"`
	ChannelID  int64        `json:"channelId"`
	CreatorID  int64        `json:"creatorId"`
	Question   string       `json:"question"`
	Multi      bool         `json:"multi"`
	Anonymous  bool         `json:"anonymous"`
	Closed     bool         `json:"closed"`
	CreatedAt  int64        `json:"createdAt"`
	Options    []PollOption `json:"options"`
	TotalVotes int          `json:"totalVotes"`
	MyVotes    []int64      `json:"myVotes"`
}

func (d *DB) loadPolls(ids []int64, viewerID int64) (map[int64]*Poll, error) {
	out := map[int64]*Poll{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := d.sql.Query(
		"SELECT id, channel_id, creator_id, question, multi, anonymous, closed, created_at FROM polls WHERE id IN ("+placeholders(len(ids))+")",
		toAny(ids)...,
	)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		p := &Poll{Options: []PollOption{}, MyVotes: []int64{}}
		var multi, anonymous, closed int
		if err := rows.Scan(&p.ID, &p.ChannelID, &p.CreatorID, &p.Question, &multi, &anonymous, &closed, &p.CreatedAt); err != nil {
			rows.Close()
			return nil, err
		}
		p.Multi = multi != 0
		p.Anonymous = anonymous != 0
		p.Closed = closed != 0
		out[p.ID] = p
	}
	rows.Close()

	for _, p := range out {
		optRows, err := d.sql.Query(`
			SELECT o.id, o.text, COUNT(v.user_id)
			FROM poll_options o LEFT JOIN poll_votes v ON v.option_id = o.id
			WHERE o.poll_id = ? GROUP BY o.id ORDER BY o.position`, p.ID)
		if err != nil {
			return nil, err
		}
		for optRows.Next() {
			var o PollOption
			if err := optRows.Scan(&o.ID, &o.Text, &o.Votes); err != nil {
				optRows.Close()
				return nil, err
			}
			p.Options = append(p.Options, o)
		}
		optRows.Close()
		_ = d.sql.QueryRow("SELECT COUNT(DISTINCT user_id) FROM poll_votes WHERE poll_id = ?", p.ID).Scan(&p.TotalVotes)
		if viewerID > 0 {
			voteRows, err := d.sql.Query("SELECT option_id FROM poll_votes WHERE poll_id = ? AND user_id = ?", p.ID, viewerID)
			if err != nil {
				return nil, err
			}
			for voteRows.Next() {
				var oid int64
				if err := voteRows.Scan(&oid); err == nil {
					p.MyVotes = append(p.MyVotes, oid)
				}
			}
			voteRows.Close()
		}
	}
	return out, nil
}

func (d *DB) PollByID(id, viewerID int64) (*Poll, error) {
	polls, err := d.loadPolls([]int64{id}, viewerID)
	if err != nil {
		return nil, err
	}
	p, ok := polls[id]
	if !ok {
		return nil, errNotFound
	}
	return p, nil
}

func (d *DB) CreatePoll(channelID, userID int64, question string, options []string, multi, anonymous bool) (Message, error) {
	question = strings.TrimSpace(question)
	if len(question) < 3 || len(question) > 200 {
		return Message{}, errors.New("Otázka musí mít 3–200 znaků")
	}
	clean := []string{}
	for _, o := range options {
		o = strings.TrimSpace(o)
		if o == "" {
			continue
		}
		if len(o) > 80 {
			return Message{}, errors.New("Odpověď je moc dlouhá (max 80 znaků)")
		}
		clean = append(clean, o)
	}
	if len(clean) < 2 || len(clean) > 10 {
		return Message{}, errors.New("Anketa potřebuje 2–10 odpovědí")
	}

	tx, err := d.sql.Begin()
	if err != nil {
		return Message{}, err
	}
	defer tx.Rollback()
	var exists int
	if err := tx.QueryRow("SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?", channelID, userID).Scan(&exists); err != nil {
		return Message{}, errors.New("Do tohoto kanálu nemáš přístup")
	}
	now := nowMS()
	res, err := tx.Exec(
		"INSERT INTO polls (channel_id, creator_id, question, multi, anonymous, closed, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)",
		channelID, userID, question, boolInt(multi), boolInt(anonymous), now,
	)
	if err != nil {
		return Message{}, err
	}
	pollID, _ := res.LastInsertId()
	for i, o := range clean {
		if _, err := tx.Exec("INSERT INTO poll_options (poll_id, text, position) VALUES (?, ?, ?)", pollID, o, i); err != nil {
			return Message{}, err
		}
	}
	res, err = tx.Exec(
		"INSERT INTO messages (channel_id, user_id, text, poll_id, created_at) VALUES (?, ?, '', ?, ?)",
		channelID, userID, pollID, now,
	)
	if err != nil {
		return Message{}, err
	}
	msgID, _ := res.LastInsertId()
	if err := tx.Commit(); err != nil {
		return Message{}, err
	}
	return d.GetMessage(msgID, userID)
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func (d *DB) VotePoll(pollID, userID int64, optionIDs []int64) (*Poll, int64, error) {
	var channelID int64
	var closed, multi int
	err := d.sql.QueryRow("SELECT channel_id, closed, multi FROM polls WHERE id = ?", pollID).Scan(&channelID, &closed, &multi)
	if err != nil {
		return nil, 0, errNotFound
	}
	if closed != 0 {
		return nil, 0, errors.New("Anketa je už uzavřená")
	}
	var member int
	if err := d.sql.QueryRow("SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?", channelID, userID).Scan(&member); err != nil {
		return nil, 0, errors.New("Do tohoto kanálu nemáš přístup")
	}
	if len(optionIDs) > 1 && multi == 0 {
		return nil, 0, errors.New("V této anketě jde vybrat jen jednu odpověď")
	}
	tx, err := d.sql.Begin()
	if err != nil {
		return nil, 0, err
	}
	defer tx.Rollback()
	if _, err := tx.Exec("DELETE FROM poll_votes WHERE poll_id = ? AND user_id = ?", pollID, userID); err != nil {
		return nil, 0, err
	}
	for _, oid := range optionIDs {
		var n int
		if err := tx.QueryRow("SELECT 1 FROM poll_options WHERE id = ? AND poll_id = ?", oid, pollID).Scan(&n); err != nil {
			return nil, 0, errors.New("Neplatná odpověď")
		}
		if _, err := tx.Exec("INSERT OR IGNORE INTO poll_votes (poll_id, option_id, user_id) VALUES (?, ?, ?)", pollID, oid, userID); err != nil {
			return nil, 0, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, 0, err
	}
	p, err := d.PollByID(pollID, userID)
	return p, channelID, err
}

func (d *DB) ClosePoll(pollID, userID int64, isAdmin bool) (*Poll, int64, error) {
	var channelID, creator int64
	err := d.sql.QueryRow("SELECT channel_id, creator_id FROM polls WHERE id = ?", pollID).Scan(&channelID, &creator)
	if err != nil {
		return nil, 0, errNotFound
	}
	if creator != userID && !isAdmin {
		return nil, 0, errors.New("Anketu může uzavřít jen autor")
	}
	if _, err := d.sql.Exec("UPDATE polls SET closed = 1 WHERE id = ?", pollID); err != nil {
		return nil, 0, err
	}
	p, err := d.PollByID(pollID, userID)
	return p, channelID, err
}

// ---- handlers ----

func (a *App) createPoll(w http.ResponseWriter, r *http.Request, u User) {
	channelID, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "Neplatný kanál")
		return
	}
	if _, member, _ := a.db.MemberRole(channelID, u.ID); !member {
		writeErr(w, http.StatusForbidden, "Do tohoto kanálu nemáš přístup")
		return
	}
	var in struct {
		Question  string   `json:"question"`
		Options   []string `json:"options"`
		Multi     bool     `json:"multi"`
		Anonymous bool     `json:"anonymous"`
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, http.StatusBadRequest, "Neplatný požadavek")
		return
	}
	msg, err := a.db.CreatePoll(channelID, u.ID, in.Question, in.Options, in.Multi, in.Anonymous)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	a.hub.BroadcastChannel(channelID, map[string]any{"type": "message:new", "channelId": channelID, "message": msg})
	writeJSON(w, http.StatusOK, map[string]any{"message": msg})
}

func (a *App) votePoll(w http.ResponseWriter, r *http.Request, u User) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "Neplatná anketa")
		return
	}
	var in struct {
		OptionIDs []int64 `json:"optionIds"`
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, http.StatusBadRequest, "Neplatný požadavek")
		return
	}
	p, channelID, err := a.db.VotePoll(id, u.ID, in.OptionIDs)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	a.hub.BroadcastChannel(channelID, map[string]any{"type": "poll:update", "channelId": channelID, "poll": p})
	writeJSON(w, http.StatusOK, map[string]any{"poll": p})
}

func (a *App) closePoll(w http.ResponseWriter, r *http.Request, u User) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "Neplatná anketa")
		return
	}
	p, channelID, err := a.db.ClosePoll(id, u.ID, u.Admin)
	if err != nil {
		writeErr(w, http.StatusForbidden, err.Error())
		return
	}
	a.hub.BroadcastChannel(channelID, map[string]any{"type": "poll:update", "channelId": channelID, "poll": p})
	writeJSON(w, http.StatusOK, map[string]any{"poll": p})
}
