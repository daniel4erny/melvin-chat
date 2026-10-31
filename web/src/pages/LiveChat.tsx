import { useEffect, useRef, useState, useCallback } from "react";
import "../styles/liveChat.css";

interface ChatMessage {
    ID: number;
    Text: string;
    CreatedAt: string;
}

const PAGE_SIZE = 50;

export default function LiveChat() {
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [error, setError] = useState("");
    const [input, setInput] = useState("");
    const [channel, setChannel] = useState("general");
    const [status, setStatus] = useState("connecting")

    const wsRef = useRef<WebSocket | null>(null);
    const chatBoxRef = useRef<HTMLDivElement>(null);
    const shownIdsRef = useRef(new Set<number>());
    const historyPageRef = useRef(0);
    const historyLoadingRef = useRef(false);
    const historyDoneRef = useRef(false);

    const loadHistory = useCallback(() => {
        if (historyLoadingRef.current || historyDoneRef.current) return;
        historyLoadingRef.current = true;
        wsRef.current?.send(`/last ${historyPageRef.current}`);
    }, []);

    useEffect(() => {
        const protocol = location.protocol === "https:" ? "wss" : "ws";
        const ws = new WebSocket(`${protocol}://${location.host}/ws`);
        wsRef.current = ws;

        ws.onopen = () => {
            console.log("Connected to the server");
            setStatus("connected")
            loadHistory();
        };

        ws.onmessage = (event) => {
            console.log("Message from server", event.data);
            const data: string = event.data;

            if (data.startsWith("#ERROR")) {
                setError(data.slice("#ERROR".length).trim());
                historyLoadingRef.current = false;
                return;
            }

            let parsed: ChatMessage | ChatMessage[];
            try {
                parsed = JSON.parse(data);
            } catch {
                console.warn("Unparseable message from server", data);
                return;
            }

            if (Array.isArray(parsed)) {
                if (parsed.length < PAGE_SIZE) historyDoneRef.current = true;
                const older = parsed
                    .reverse()
                    .filter((msg) => !shownIdsRef.current.has(msg.ID));
                older.forEach((msg) => shownIdsRef.current.add(msg.ID));

                setMessages((prev) => {
                    const chatBox = chatBoxRef.current;
                    const fromBottom = chatBox
                        ? chatBox.scrollHeight - chatBox.scrollTop
                        : 0;

                    // schedule scroll restore after render
                    if (chatBox) {
                        requestAnimationFrame(() => {
                            if (historyPageRef.current === 1) {
                                chatBox.scrollTop = chatBox.scrollHeight;
                            } else {
                                chatBox.scrollTop = chatBox.scrollHeight - fromBottom;
                            }
                        });
                    }

                    return [...older, ...prev];
                });

                historyPageRef.current++;
                historyLoadingRef.current = false;
            } else {
                if (shownIdsRef.current.has(parsed.ID)) return;
                shownIdsRef.current.add(parsed.ID);

                setMessages((prev) => {
                    const chatBox = chatBoxRef.current;
                    const atBottom = chatBox
                        ? chatBox.scrollHeight - chatBox.scrollTop - chatBox.clientHeight <
                        50
                        : true;

                    if (atBottom && chatBox) {
                        requestAnimationFrame(() => {
                            chatBox.scrollTop = chatBox.scrollHeight;
                        });
                    }

                    return [...prev, parsed as ChatMessage];
                });
            }
        };

        ws.onclose = () => {
            console.log("Disconnected from the server");
            setStatus("disconected");
        }
        ws.onerror = (err) => console.error("WebSocket error:", err);

        return () => {
            ws.close();
        };
    }, [loadHistory]);

    // scroll-to-load-history
    useEffect(() => {
        const chatBox = chatBoxRef.current;
        if (!chatBox) return;
        const onScroll = () => {
            if (chatBox.scrollTop < 100) loadHistory();
        };
        chatBox.addEventListener("scroll", onScroll);
        return () => chatBox.removeEventListener("scroll", onScroll);
    }, [loadHistory]);

    const sendMessage = () => {
        if (!input.trim()) return;
        setError("");
        wsRef.current?.send(input);
        setInput("");
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "Enter") sendMessage();
    };

    return (
        <>
            <nav className="channels">
                <div className="seperator">
                    <h1>CHANNELS</h1>
                    <button
                        id="general"
                        onClick={() => setChannel("general")}
                        className={channel === "general" ? "active" : ""}
                    >
                        #general
                    </button>
                    <button
                        id="school"
                        onClick={() => setChannel("school")}
                        className={channel === "school" ? "active" : ""}
                    >
                        #school
                    </button>
                </div>
                <span>{status}</span>
            </nav>
            <main>
                <div id="chatBox" ref={chatBoxRef}>
                    {messages.map((msg) => (
                        <div className="chatMessage" key={msg.ID} data-id={msg.ID}>
                            <span className="chatId">{msg.ID}</span>
                            <span className="chatTime">
                                {new Date(msg.CreatedAt).toLocaleDateString()}{" "}
                                {new Date(msg.CreatedAt).toLocaleTimeString()}
                            </span>
                            <span>{msg.Text}</span>
                        </div>
                    ))}
                </div>
                {error && <div id="chatError">{error}</div>}
                <div className="chatInput">
                    <input
                    type="text"
                    id="message"
                    placeholder="Type a message..."
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    />
                    <button onClick={sendMessage}>Send</button>
                </div>
            </main>
        </>
    );
}
