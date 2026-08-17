export const WEIXIN_DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
export const WEIXIN_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

export type QrStatus =
  | "wait" | "scaned" | "confirmed" | "expired" | "scaned_but_redirect"
  | "need_verifycode" | "verify_code_blocked" | "binded_redirect";

export type QrCodeResponse = { qrcode: string; qrcodeUrl: string };
export type QrStatusResponse = {
  status: QrStatus;
  botToken?: string;
  ilinkBotId?: string;
  ilinkUserId?: string;
  baseUrl?: string;
  redirectHost?: string;
  message?: string;
};

export type ImageItem = {
  aeskey?: string;
  media?: {
    aes_key?: string;
    encrypt_query_param?: string;
    full_url?: string;
  };
};
export type WeixinItem = {
  type: number;
  text_item?: { text?: string };
  image_item?: ImageItem;
};
export type WeixinMessage = {
  message_id?: string | number;
  client_id?: string;
  from_user_id?: string;
  group_id?: string;
  context_token?: string;
  message_type?: number;
  item_list?: WeixinItem[];
};
export type UpdatesResponse = {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
};
