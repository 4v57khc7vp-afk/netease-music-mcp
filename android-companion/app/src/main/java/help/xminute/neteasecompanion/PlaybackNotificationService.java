package help.xminute.neteasecompanion;

import android.content.ComponentName;
import android.content.SharedPreferences;
import android.media.MediaMetadata;
import android.media.session.MediaController;
import android.media.session.MediaSessionManager;
import android.media.session.PlaybackState;
import android.os.Handler;
import android.os.HandlerThread;
import android.service.notification.NotificationListenerService;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class PlaybackNotificationService extends NotificationListenerService {
    private static final Pattern NUMERIC_ID = Pattern.compile("(?:^|[^0-9])(\\d{5,20})(?:$|[^0-9])");
    private static final long REPORT_INTERVAL_MS = 2_000;

    private final ExecutorService network = Executors.newSingleThreadExecutor();
    private HandlerThread workerThread;
    private Handler worker;
    private MediaSessionManager sessions;
    private MediaController controller;
    private String deviceId;
    private final AtomicBoolean requestInFlight = new AtomicBoolean(false);
    private final MediaSessionManager.OnActiveSessionsChangedListener sessionListener = this::selectController;

    @Override public void onListenerConnected() {
        super.onListenerConnected();
        workerThread = new HandlerThread("netease-playback-companion");
        workerThread.start();
        worker = new Handler(workerThread.getLooper());
        sessions = getSystemService(MediaSessionManager.class);
        SharedPreferences prefs = getSharedPreferences(MainActivity.PREFS, MODE_PRIVATE);
        deviceId = prefs.getString("device_id", null);
        if (deviceId == null) {
            deviceId = "android-" + UUID.randomUUID();
            prefs.edit().putString("device_id", deviceId).apply();
        }
        sessions.addOnActiveSessionsChangedListener(sessionListener, new ComponentName(this, getClass()), worker);
        selectController(sessions.getActiveSessions(new ComponentName(this, getClass())));
        worker.post(reportLoop);
        setStatus("已连接，等待网易云播放");
    }

    @Override public void onListenerDisconnected() {
        if (worker != null) worker.removeCallbacksAndMessages(null);
        if (sessions != null) sessions.removeOnActiveSessionsChangedListener(sessionListener);
        if (workerThread != null) workerThread.quitSafely();
        network.shutdownNow();
        super.onListenerDisconnected();
    }

    private void selectController(List<MediaController> active) {
        MediaController best = null;
        int bestScore = Integer.MIN_VALUE;
        for (MediaController candidate : active) {
            String name = candidate.getPackageName().toLowerCase();
            if (name.contains("netease") || name.contains("cloudmusic")) {
                PlaybackState state = candidate.getPlaybackState();
                MediaMetadata metadata = candidate.getMetadata();
                int score = metadata == null ? 0 : 10;
                if (state != null) {
                    if (state.getState() == PlaybackState.STATE_PLAYING) score += 300;
                    else if (state.getState() == PlaybackState.STATE_BUFFERING) score += 200;
                    else if (state.getState() == PlaybackState.STATE_PAUSED) score += 100;
                }
                if (score > bestScore) {
                    best = candidate;
                    bestScore = score;
                }
            }
        }
        controller = best;
    }

    private final Runnable reportLoop = new Runnable() {
        @Override public void run() {
            try { report(); } catch (Exception error) { setStatus("读取失败：" + error.getMessage()); }
            if (worker != null) worker.postDelayed(this, REPORT_INTERVAL_MS);
        }
    };

    private void report() throws Exception {
        if (sessions != null) {
            selectController(sessions.getActiveSessions(new ComponentName(this, getClass())));
        }
        MediaController current = controller;
        if (current == null) {
            if (sessions != null) selectController(sessions.getActiveSessions(new ComponentName(this, getClass())));
            return;
        }
        MediaMetadata metadata = current.getMetadata();
        PlaybackState playback = current.getPlaybackState();
        if (metadata == null || playback == null) return;

        String title = first(metadata.getString(MediaMetadata.METADATA_KEY_TITLE), metadata.getString(MediaMetadata.METADATA_KEY_DISPLAY_TITLE));
        String artist = first(metadata.getString(MediaMetadata.METADATA_KEY_ARTIST), metadata.getString(MediaMetadata.METADATA_KEY_ALBUM_ARTIST));
        String mediaId = metadata.getString(MediaMetadata.METADATA_KEY_MEDIA_ID);
        String songId = extractSongId(mediaId);

        JSONObject body = new JSONObject();
        body.put("deviceId", deviceId);
        body.put("songId", songId == null ? JSONObject.NULL : songId);
        if (songId != null) body.put("songIdSource", "android_media_session");
        body.put("title", title == null ? "" : title);
        body.put("artists", new JSONArray().put(artist == null ? "" : artist));
        body.put("durationMs", metadata.getLong(MediaMetadata.METADATA_KEY_DURATION));
        body.put("positionMs", Math.max(0, playback.getPosition()));
        body.put("isPlaying", playback.getState() == PlaybackState.STATE_PLAYING);
        body.put("playbackState", stateName(playback.getState()));
        body.put("reportedAt", System.currentTimeMillis());
        send(body);
    }

    private void send(JSONObject body) {
        SharedPreferences prefs = getSharedPreferences(MainActivity.PREFS, MODE_PRIVATE);
        String base = prefs.getString(MainActivity.KEY_SERVER, "");
        String token = prefs.getString(MainActivity.KEY_TOKEN, "");
        if (!base.startsWith("https://") || token.isEmpty()) return;
        if (!requestInFlight.compareAndSet(false, true)) return;
        network.execute(() -> {
            HttpURLConnection connection = null;
            try {
                connection = (HttpURLConnection) new URL(base + "/api/v1/playback/state").openConnection();
                connection.setRequestMethod("POST");
                connection.setConnectTimeout(10_000);
                connection.setReadTimeout(10_000);
                connection.setRequestProperty("Authorization", "Bearer " + token);
                connection.setRequestProperty("Content-Type", "application/json");
                connection.setDoOutput(true);
                byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
                try (OutputStream output = connection.getOutputStream()) { output.write(bytes); }
                int code = connection.getResponseCode();
                setStatus(code >= 200 && code < 300 ? "上报成功：" + body.optString("title") : "服务器返回 HTTP " + code);
            } catch (Exception error) {
                setStatus("上报失败：" + error.getClass().getSimpleName());
            } finally {
                if (connection != null) connection.disconnect();
                requestInFlight.set(false);
            }
        });
    }

    private void setStatus(String value) {
        getSharedPreferences(MainActivity.PREFS, MODE_PRIVATE).edit().putString(MainActivity.KEY_STATUS, value).apply();
    }

    private static String extractSongId(String mediaId) {
        if (mediaId == null) return null;
        Matcher matcher = NUMERIC_ID.matcher(mediaId);
        return matcher.find() ? matcher.group(1) : null;
    }

    private static String first(String first, String second) {
        return first != null && !first.isBlank() ? first : second;
    }

    private static String stateName(int state) {
        if (state == PlaybackState.STATE_PLAYING) return "playing";
        if (state == PlaybackState.STATE_PAUSED) return "paused";
        if (state == PlaybackState.STATE_BUFFERING) return "buffering";
        if (state == PlaybackState.STATE_STOPPED) return "stopped";
        return "other";
    }
}
