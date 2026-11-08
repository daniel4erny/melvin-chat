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
  soundStyle: "chime" | "pop" | "blip" | "bell";
  soundVolume: number;
  callSounds: boolean;
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
  avatarId: string;
  pronouns: string;
  location: string;
  website: string;
  lastSeen: number;
  timeoutUntil?: number;
  timeoutReason: string;
  settings: UserSettings;
  createdAt: number;
  roleColor?: string;
  roleName?: string;
  roleIds?: number[];
  permissions?: number;
};

export type Role = {
  id: number;
  name: string;
  color: string;
  position: number;
  permissions: number;
  createdAt: number;
};

export const PERM_MANAGE_CHANNELS = 1;
export const PERM_MANAGE_MESSAGES = 2;
export const PERM_MANAGE_MEMBERS = 4;

export type AttachmentKind = "file" | "image" | "video" | "audio" | "voice" | "sticker";

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

export type Sticker = {
  id: string;
  userId: number;
  name: string;
  emoji: string;
  attachmentId?: string;
  position: number;
  createdAt: number;
};

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
  pinned: boolean;
  attachment?: Attachment;
  sticker?: Sticker;
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

export type ChannelCategory = {
  id: number;
  name: string;
  position: number;
  createdBy: number;
};

export type Channel = {
  id: number;
  name: string;
  topic: string;
  visibility: "public" | "private" | "direct";
  ownerId: number;
  createdAt: number;
  categoryId: number;
  kind: "text" | "voice";
  slowmode: number;
  role: "owner" | "member";
  memberCount: number;
  unread: number;
  dm?: boolean;
  group?: boolean;
  peer?: User;
  peers?: User[];
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
  avatarId?: string;
  muted?: boolean;
};

export type SharedChannel = { id: number; name: string; visibility: string };

export type UserStats = {
  messages: number;
  reactions: number;
  channels: number;
  sharedChannels: SharedChannel[];
};

export type UserIP = {
  ip: string;
  firstSeen: number;
  lastSeen: number;
  hits: number;
  userAgent: string;
};

export type UserProfileResponse = {
  user: User;
  stats: UserStats;
  online: boolean;
  timeoutLeft: number;
  ips?: UserIP[];
};

export type WSStatus = "connecting" | "online" | "offline";
