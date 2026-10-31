export type UserSettings = {
  theme: "dark" | "light" | "system";
  accent: string;
  density: "cozy" | "compact";
  fontScale: number;
  showErrors: boolean;
  showTimestamps: boolean;
  enterToSend: boolean;
  notifications: boolean;
  presence: "everyone" | "nobody";
  messageSound: boolean;
  bubbleStyle: "rounded" | "flat";
};

export type User = {
  id: number;
  username: string;
  displayName: string;
  avatarColor: string;
  bio: string;
  admin: boolean;
  statusEmoji: string;
  statusText: string;
  banned: boolean;
  banReason: string;
  bannedUntil?: number;
  settings: UserSettings;
  createdAt: number;
};

export type AttachmentKind = "file" | "image" | "video" | "audio" | "voice";

export type Attachment = {
  id: string;
  uploaderId: number;
  name: string;
  mime: string;
  size: number;
  kind: AttachmentKind;
  duration: number;
  createdAt: number;
};

export type Reaction = { emoji: string; count: number; mine: boolean };

export type PollOption = { id: number; text: string; votes: number };

export type Poll = {
  id: number;
  channelId: number;
  creatorId: number;
  question: string;
  multi: boolean;
  anonymous: boolean;
  closed: boolean;
  createdAt: number;
  options: PollOption[];
  totalVotes: number;
  myVotes: number[];
};

export type Message = {
  id: number;
  channelId: number;
  user: User;
  text: string;
  createdAt: number;
  editedAt?: number;
  deleted: boolean;
  attachment?: Attachment;
  poll?: Poll;
  replyTo?: number;
  reactions: Reaction[];
};

export type MessagePreview = {
  text: string;
  createdAt: number;
  displayName: string;
  kind: string;
  fileName: string;
};

export type Channel = {
  id: number;
  name: string;
  topic: string;
  visibility: "public" | "private";
  ownerId: number;
  createdAt: number;
  role: "owner" | "member";
  memberCount: number;
  unread: number;
  lastMessage?: MessagePreview;
};

export type ChannelMember = User & { role: "owner" | "member"; online: boolean };

export type AppConfig = {
  maxUploadMB: number;
  iceServers: string[];
  registrationOpen: boolean;
  needsInvite: boolean;
  version: string;
};

export type Invite = {
  code: string;
  createdBy: number;
  note: string;
  maxUses: number;
  uses: number;
  createdAt: number;
  expiresAt?: number;
  revoked: boolean;
  active: boolean;
};

export type CallPeer = {
  id: number;
  username: string;
  displayName: string;
  avatarColor: string;
};

export type WSStatus = "connecting" | "online" | "offline";
