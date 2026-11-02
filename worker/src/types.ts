export interface Env {
  DB: D1Database;
  R2_BUCKET: R2Bucket;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  SESSION_SECRET: string;
  APP_ORIGIN: string;
  MAX_UPLOAD_BYTES: string;
  CHUNK_SIZE: string;
  MAX_CONCURRENT_CHUNKS: string;
  UPLOAD_EXPIRY_HOURS: string;
  CLEANUP_INTERVAL_MINUTES: string;
  MAX_CONCURRENT_UPLOADS_PER_USER: string;
  RATE_LIMIT_WINDOW_SECONDS: string;
  RATE_LIMIT_MAX_REQUESTS: string;
  R2_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
}

export interface Upload {
  id: string;
  telegram_user_id: number;
  telegram_chat_id: number | null;
  original_filename: string;
  object_key: string;
  file_size: number;
  mime_type: string;
  multipart_upload_id: string | null;
  status: 'uploading' | 'uploaded' | 'aborted' | 'expired' | 'failed';
  created_at: number;
  updated_at: number;
  expires_at: number;
  completed_etag: string | null;
  completed_size: number | null;
  error_message: string | null;
}

export interface UploadPart {
  id: number;
  upload_id: string;
  part_number: number;
  etag: string | null;
  size: number | null;
  uploaded_at: number | null;
}

export interface User {
  telegram_user_id: number;
  first_name: string | null;
  last_name: string | null;
  username: string | null;
  language_code: string | null;
  preferred_aspect_ratio: string;
  preferred_caption_style: string;
  enable_tighten: number;
  enable_loudnorm: number;
  created_at: number;
  updated_at: number;
}

export interface Job {
  id: string;
  upload_id: string;
  telegram_user_id: number;
  status: 'pending' | 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';
  aspect_ratio: string;
  caption_style: string;
  enable_tighten: number;
  enable_loudnorm: number;
  clip_count: number;
  error_message: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

export interface TelegramInitData {
  query_id?: string;
  user?: TelegramUser;
  receiver?: TelegramUser;
  chat?: TelegramChat;
  chat_type?: string;
  chat_instance?: string;
  start_param?: string;
  can_send_after?: number;
  auth_date: number;
  hash: string;
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
  added_to_attachment_menu?: boolean;
  allows_write_to_pm?: boolean;
}

export interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
  is_forum?: boolean;
}

export interface TelegramWebhookUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
  edited_channel_post?: TelegramMessage;
  inline_query?: TelegramInlineQuery;
  chosen_inline_result?: TelegramChosenInlineResult;
  callback_query?: TelegramCallbackQuery;
  shipping_query?: TelegramShippingQuery;
  pre_checkout_query?: TelegramPreCheckoutQuery;
  poll?: TelegramPoll;
  poll_answer?: TelegramPollAnswer;
  my_chat_member?: TelegramChatMemberUpdated;
  chat_member?: TelegramChatMemberUpdated;
  chat_join_request?: TelegramChatJoinRequest;
}

export interface TelegramMessage {
  message_id: number;
  message_thread_id?: number;
  from?: TelegramUser;
  sender_chat?: TelegramChat;
  date: number;
  chat: TelegramChat;
  forward_from?: TelegramUser;
  forward_from_chat?: TelegramChat;
  forward_from_message_id?: number;
  forward_signature?: string;
  forward_sender_name?: string;
  forward_date?: number;
  is_automatic_forward?: boolean;
  reply_to_message?: TelegramMessage;
  via_bot?: TelegramUser;
  edit_date?: number;
  has_protected_content?: boolean;
  media_group_id?: string;
  author_signature?: string;
  text?: string;
  entities?: TelegramMessageEntity[];
  animation?: TelegramAnimation;
  audio?: TelegramAudio;
  document?: TelegramDocument;
  photo?: TelegramPhotoSize[];
  sticker?: TelegramSticker;
  video?: TelegramVideo;
  video_note?: TelegramVideoNote;
  voice?: TelegramVoice;
  caption?: string;
  caption_entities?: TelegramMessageEntity[];
  has_media_spoiler?: boolean;
  contact?: TelegramContact;
  dice?: TelegramDice;
  game?: TelegramGame;
  poll?: TelegramPoll;
  venue?: TelegramVenue;
  location?: TelegramLocation;
  new_chat_members?: TelegramUser[];
  left_chat_member?: TelegramUser;
  new_chat_title?: string;
  new_chat_photo?: TelegramPhotoSize[];
  delete_chat_photo?: boolean;
  group_chat_created?: boolean;
  supergroup_chat_created?: boolean;
  channel_chat_created?: boolean;
  migrate_to_chat_id?: number;
  migrate_from_chat_id?: number;
  pinned_message?: TelegramMessage;
  invoice?: TelegramInvoice;
  successful_payment?: TelegramSuccessfulPayment;
  connected_website?: string;
  write_access_allowed?: TelegramWriteAccessAllowed;
  passport_data?: TelegramPassportData;
  proximity_alert_triggered?: TelegramProximityAlertTriggered;
  forum_topic_created?: TelegramForumTopicCreated;
  forum_topic_edited?: TelegramForumTopicEdited;
  forum_topic_closed?: TelegramForumTopicClosed;
  forum_topic_reopened?: TelegramForumTopicReopened;
  general_forum_topic_hidden?: TelegramGeneralForumTopicHidden;
  general_forum_topic_unhidden?: TelegramGeneralForumTopicUnhidden;
  video_chat_scheduled?: TelegramVideoChatScheduled;
  video_chat_started?: TelegramVideoChatStarted;
  video_chat_ended?: TelegramVideoChatEnded;
  video_chat_participants_invited?: TelegramVideoChatParticipantsInvited;
  web_app_data?: TelegramWebAppData;
  reply_markup?: TelegramInlineKeyboardMarkup;
}

export interface TelegramInlineKeyboardMarkup {
  inline_keyboard: TelegramInlineKeyboardButton[][];
}

export interface TelegramInlineKeyboardButton {
  text: string;
  url?: string;
  callback_data?: string;
  web_app?: TelegramWebAppInfo;
  switch_inline_query?: string;
  switch_inline_query_current_chat?: string;
  switch_inline_query_chosen_chat?: TelegramSwitchInlineQueryChosenChat;
  copy_text?: TelegramCopyTextButton;
  callback_game?: TelegramCallbackGame;
  pay?: boolean;
}

export interface TelegramWebAppInfo {
  url: string;
}

export interface TelegramWebAppData {
  button_text: string;
  data: string;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  inline_message_id?: string;
  chat_instance: string;
  data?: string;
  game_short_name?: string;
}

export interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  thumbnail?: TelegramPhotoSize;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramVideo {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  duration: number;
  thumbnail?: TelegramPhotoSize;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramMessageEntity {
  type: string;
  offset: number;
  length: number;
  url?: string;
  user?: TelegramUser;
  language?: string;
  custom_emoji_id?: string;
}

export interface TelegramInlineQuery {
  id: string;
  from: TelegramUser;
  query: string;
  offset: string;
  chat_type?: string;
  location?: TelegramLocation;
}

export interface TelegramChosenInlineResult {
  result_id: string;
  from: TelegramUser;
  location?: TelegramLocation;
  inline_message_id?: string;
  query: string;
}

export interface TelegramShippingQuery {
  id: string;
  from: TelegramUser;
  invoice_payload: string;
  shipping_address: TelegramShippingAddress;
}

export interface TelegramShippingAddress {
  country_code: string;
  state: string;
  city: string;
  street_line1: string;
  street_line2: string;
  post_code: string;
}

export interface TelegramPreCheckoutQuery {
  id: string;
  from: TelegramUser;
  currency: string;
  total_amount: number;
  invoice_payload: string;
  shipping_option_id?: string;
  order_info?: TelegramOrderInfo;
}

export interface TelegramOrderInfo {
  name?: string;
  phone_number?: string;
  email?: string;
  shipping_address?: TelegramShippingAddress;
}

export interface TelegramPoll {
  id: string;
  question: string;
  options: TelegramPollOption[];
  total_voter_count: number;
  is_closed: boolean;
  is_anonymous: boolean;
  type: string;
  allows_multiple_answers: boolean;
  correct_option_id?: number;
  explanation?: string;
  explanation_entities?: TelegramMessageEntity[];
  open_period?: number;
  close_date?: number;
}

export interface TelegramPollOption {
  text: string;
  voter_count: number;
}

export interface TelegramPollAnswer {
  poll_id: string;
  voter_chat?: TelegramChat;
  user?: TelegramUser;
  option_ids: number[];
}

export interface TelegramChatMemberUpdated {
  chat: TelegramChat;
  from: TelegramUser;
  date: number;
  old_chat_member: TelegramChatMember;
  new_chat_member: TelegramChatMember;
  invite_link?: TelegramChatInviteLink;
  via_chat_folder_invite_link?: boolean;
}

export interface TelegramChatMember {
  user: TelegramUser;
  status: string;
  until_date?: number;
  can_be_edited?: boolean;
  can_manage_chat?: boolean;
  can_manage_video_chats?: boolean;
  can_delete_messages?: boolean;
  can_restrict_members?: boolean;
  can_promote_members?: boolean;
  can_change_info?: boolean;
  can_invite_users?: boolean;
  can_post_messages?: boolean;
  can_edit_messages?: boolean;
  can_pin_messages?: boolean;
  can_manage_topics?: boolean;
  is_member?: boolean;
  is_admin?: boolean;
  custom_title?: string;
}

export interface TelegramChatInviteLink {
  invite_link: string;
  creator: TelegramUser;
  creates_join_request: boolean;
  is_primary: boolean;
  is_revoked: boolean;
  expire_date?: number;
  member_limit?: number;
  pending_join_request_count?: number;
}

export interface TelegramChatJoinRequest {
  chat: TelegramChat;
  from: TelegramUser;
  user_chat_id?: number;
  date: number;
  bio?: string;
  invite_link?: TelegramChatInviteLink;
}

export interface TelegramWriteAccessAllowed {
  from_request?: boolean;
  web_app_name?: string;
  from_attachment_menu?: boolean;
}

export interface TelegramPassportData {
  data: TelegramEncryptedPassportElement[];
  credentials: TelegramEncryptedCredentials;
}

export interface TelegramEncryptedPassportElement {
  type: string;
  data?: string;
  phone_number?: string;
  email?: string;
  files?: TelegramPassportFile[];
  front_side?: TelegramPassportFile;
  reverse_side?: TelegramPassportFile;
  selfie?: TelegramPassportFile;
  translation?: TelegramPassportFile[];
  hash: string;
}

export interface TelegramPassportFile {
  file_id: string;
  file_unique_id: string;
  file_size: number;
  file_date: number;
}

export interface TelegramEncryptedCredentials {
  data: string;
  hash: string;
  secret: string;
}

export interface TelegramProximityAlertTriggered {
  traveler: TelegramUser;
  watcher: TelegramUser;
  distance: number;
}

export interface TelegramForumTopicCreated {
  name: string;
  icon_color: number;
  icon_custom_emoji_id?: string;
}

export interface TelegramForumTopicEdited {
  name?: string;
  icon_custom_emoji_id?: string;
}

export interface TelegramForumTopicClosed {
}

export interface TelegramForumTopicReopened {
}

export interface TelegramGeneralForumTopicHidden {
}

export interface TelegramGeneralForumTopicUnhidden {
}

export interface TelegramVideoChatScheduled {
  start_date: number;
}

export interface TelegramVideoChatStarted {
}

export interface TelegramVideoChatEnded {
  duration: number;
}

export interface TelegramVideoChatParticipantsInvited {
  users: TelegramUser[];
}

export interface TelegramSwitchInlineQueryChosenChat {
  query: string;
  allow_user_chats: boolean;
  allow_bot_chats: boolean;
  allow_group_chats: boolean;
  allow_channel_chats: boolean;
}

export interface TelegramCopyTextButton {
  text: string;
}

export interface TelegramCallbackGame {
}

export interface TelegramVideoNote {
  file_id: string;
  file_unique_id: string;
  length: number;
  duration: number;
  thumbnail?: TelegramPhotoSize;
  file_size?: number;
}

export interface TelegramVoice {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramContact {
  phone_number: string;
  first_name: string;
  last_name?: string;
  user_id?: number;
  vcard?: string;
}

export interface TelegramDice {
  emoji: string;
  value: number;
}

export interface TelegramGame {
  title: string;
  description: string;
  photo: TelegramPhotoSize[];
  text?: string;
  text_entities?: TelegramMessageEntity[];
  animation?: TelegramAnimation;
}

export interface TelegramAnimation {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  duration: number.
  thumbnail?: TelegramPhotoSize;
  file_name?: string;
  mime_type?: string;
  file_size?: number.
}

export interface TelegramAudio {
  file_id: string;
  file_unique_id: string;
  duration: number;
  performer?: string;
  title?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
  thumbnail?: TelegramPhotoSize;
}

export interface TelegramSticker {
  file_id: string;
  file_unique_id: string;
  type: string;
  width: number;
  height: number.
  is_animated: boolean.
  is_video: boolean.
  thumbnail?: TelegramPhotoSize;
  emoji?: string.
  set_name?: string.
  premium_animation?: TelegramFile.
  mask_position?: TelegramMaskPosition.
  custom_emoji_id?: string.
  needs_repainting?: boolean.
  file_size?: number.
}

export interface TelegramFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number.
  file_path?: string.
}

export interface TelegramMaskPosition {
  point: string.
  x_shift: number.
  y_shift: number.
  scale: number.
}

export interface TelegramVenue {
  location: TelegramLocation.
  title: string.
  address: string.
  foursquare_id?: string.
  foursquare_type?: string.
  google_place_id?: string.
  google_place_type?: string.
}

export interface TelegramLocation {
  longitude: number.
  latitude: number.
  horizontal_accuracy?: number.
  live_period?: number.
  heading?: number.
  proximity_alert_radius?: number.
}

export interface TelegramInvoice {
  title: string.
  description: string.
  start_parameter: string.
  currency: string.
  total_amount: number.
}

export interface TelegramSuccessfulPayment {
  currency: string.
  total_amount: number.
  invoice_payload: string.
  shipping_option_id?: string.
  order_info?: TelegramOrderInfo.
  telegram_payment_charge_id: string.
  provider_payment_charge_id: string.
}

export interface PresignedUrlResponse {
  uploadId: string.
  key: string.
  partNumber: number.
  url: string.
  expiresAt: number.
}

export interface InitiateMultipartResponse {
  uploadId: string.
  key: string.
  expiresAt: number.
  partUrls: PresignedUrlResponse[].
}

export interface CompleteMultipartRequest {
  uploadId: string.
  key: string.
  parts: { partNumber: number; etag: string }[].
}

export interface ApiResponse<T = unknown> {
  ok: boolean.
  data?: T.
  error?: string.
  code?: string.
}

export interface UploadStatusResponse {
  upload: Upload.
  parts: UploadPart[].
  progress: {
    uploadedBytes: number.
    totalBytes: number.
    percentage: number.
  }.
}

export interface UserUploadsResponse {
  uploads: Upload[].
}

export interface JobResponse {
  job: Job.
}

export interface UserJobsResponse {
  jobs: Job[].
}