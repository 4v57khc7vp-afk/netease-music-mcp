import { randomBytes } from 'node:crypto';

import { encryptEapi } from './playlist.js';
import { loadNeteaseSession } from './session.js';

const API_ORIGIN = 'https://music.163.com';
const USER_AGENT = 'Mozilla/5.0 AppleWebKit/537.36 Chrome/136 Safari/537.36';
const DEVICE_ID = `netease-mcp-listen-${randomBytes(16).toString('hex')}`;
const INVITE_HOSTS = new Set(['163cn.tv', 'st.music.163.com']);
const ROOM_ID_PATTERN = /^[a-f0-9]{32}_\d{10,13}$/i;
const USER_ID_PATTERN = /^\d{1,20}$/;

function validateInviteUrl(value) {
  let url;
  try {
    url = new URL(String(value ?? '').trim());
  } catch {
    throw new Error('一起听邀请链接无效。');
  }
  if (url.protocol !== 'https:' || !INVITE_HOSTS.has(url.hostname)) {
    throw new Error('只接受网易云官方的 163cn.tv 或 st.music.163.com 邀请链接。');
  }
  return url;
}

function parseLongInviteUrl(url) {
  const roomId = url.searchParams.get('roomId') ?? '';
  const inviterId = url.searchParams.get('inviterId') ?? '';
  if (!ROOM_ID_PATTERN.test(roomId) || !USER_ID_PATTERN.test(inviterId)) {
    throw new Error('邀请链接缺少有效的 roomId 或 inviterId，可能已经失效。');
  }
  return { roomId, inviterId, inviteUrl: url.href };
}

export async function resolveListenTogetherInvite(
  inviteUrl,
  { fetchImpl = fetch } = {},
) {
  let url = validateInviteUrl(inviteUrl);

  for (let redirects = 0; redirects < 5; redirects += 1) {
    if (url.hostname === 'st.music.163.com') return parseLongInviteUrl(url);

    const response = await fetchImpl(url, {
      redirect: 'manual',
      headers: { Accept: 'text/html', 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(12_000),
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error('网易云短链接跳转响应缺少地址。');
      url = validateInviteUrl(new URL(location, url).href);
      continue;
    }

    if (!response.ok) {
      throw new Error(`网易云邀请短链接返回 HTTP ${response.status}`);
    }

    const html = await response.text();
    const match = html.match(
      /https:\/\/st\.music\.163\.com\/listen-together\/share\/\?[^"'<>\s]+/i,
    );
    if (!match) throw new Error('无法从网易云短链接解析一起听房间。');
    url = validateInviteUrl(match[0].replaceAll('&amp;', '&'));
  }

  throw new Error('网易云邀请短链接跳转次数过多。');
}

async function requestEapi(
  apiPath,
  params,
  { fetchImpl = fetch, sessionProvider = loadNeteaseSession } = {},
) {
  const session = await sessionProvider();
  const payload = {
    ...params,
    csrf_token: session.csrfToken,
    header: JSON.stringify({
      os: 'osx',
      appver: '3.1.9',
      deviceId: DEVICE_ID,
      requestId: `${Date.now()}_0`,
      osver: 'macOS',
    }),
  };
  const response = await fetchImpl(
    new URL(apiPath.replace(/^\/api\//, '/eapi/'), API_ORIGIN),
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: session.cookieHeader,
        Referer: `${API_ORIGIN}/`,
        'User-Agent': USER_AGENT,
      },
      body: new URLSearchParams({
        params: encryptEapi(apiPath, payload),
      }).toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(12_000),
    },
  );

  if (!response.ok) throw new Error(`网易云一起听接口返回 HTTP ${response.status}`);
  const result = await response.json();
  if (Number(result?.code) !== 200) {
    if (Number(result?.code) === 301) {
      throw new Error('网易云登录会话已失效，请重新导入。');
    }
    throw new Error(
      `网易云一起听操作失败（code ${result?.code ?? 'unknown'}）：${result?.message ?? result?.msg ?? '未知错误'}`,
    );
  }
  return result;
}

export async function getListenTogetherRoomStatus(options = {}) {
  const result = await requestEapi(
    '/api/listen/together/status/get',
    {},
    options,
  );
  const roomInfo = result?.data?.roomInfo ?? null;
  return {
    inRoom: Boolean(result?.data?.inRoom),
    status: result?.data?.status ?? null,
    room: roomInfo
      ? {
          roomId: roomInfo.roomId,
          creatorId: String(roomInfo.creatorId ?? ''),
          users: (roomInfo.roomUsers ?? []).map((user) => ({
            userId: String(user.userId ?? ''),
            nickname: user.nickname ?? '',
            avatarUrl: user.avatarUrl ?? null,
          })),
        }
      : null,
  };
}

export async function joinListenTogetherRoom(
  inviteUrl,
  { leaveCurrentRoom = false, ...options } = {},
) {
  const invite = await resolveListenTogetherInvite(inviteUrl, options);
  const current = await getListenTogetherRoomStatus(options);

  if (current.inRoom && current.room?.roomId === invite.roomId) {
    return { joined: true, alreadyJoined: true, ...current };
  }

  if (current.inRoom) {
    if (!leaveCurrentRoom) {
      throw new Error('当前账号已在另一个一起听房间。确认切换后请传 leaveCurrentRoom=true。');
    }
    await requestEapi(
      '/api/listen/together/end/v2',
      { roomId: current.room.roomId },
      options,
    );
  }

  const accepted = await requestEapi(
    '/api/listen/together/play/invitation/accept',
    {
      refer: 'inbox_invite',
      roomId: invite.roomId,
      inviterId: invite.inviterId,
    },
    options,
  );
  const status = await getListenTogetherRoomStatus(options);
  return {
    joined: status.inRoom && status.room?.roomId === invite.roomId,
    alreadyJoined: accepted?.data?.type === 'ALREADY_IN_ROOM',
    responseType: accepted?.data?.type ?? null,
    ...status,
  };
}

export async function leaveListenTogetherRoom(options = {}) {
  const current = await getListenTogetherRoomStatus(options);
  if (!current.inRoom || !current.room) {
    return { left: false, reason: 'not_in_room' };
  }
  await requestEapi(
    '/api/listen/together/end/v2',
    { roomId: current.room.roomId },
    options,
  );
  return { left: true, roomId: current.room.roomId };
}
