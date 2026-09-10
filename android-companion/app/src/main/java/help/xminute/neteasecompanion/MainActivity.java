package help.xminute.neteasecompanion;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Typeface;
import android.os.Bundle;
import android.provider.Settings;
import android.text.InputType;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

public final class MainActivity extends Activity {
    static final String PREFS = "companion";
    static final String KEY_SERVER = "server_url";
    static final String KEY_TOKEN = "bearer_token";
    static final String KEY_STATUS = "last_status";

    private EditText server;
    private EditText token;
    private TextView status;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(24), dp(28), dp(24), dp(24));

        TextView title = text("网易云播放伴侣", 26);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        root.addView(title);
        root.addView(text("把备用机的系统媒体状态安全上报到你的私人 MCP。", 15));

        root.addView(text("服务器地址", 14));
        server = new EditText(this);
        server.setSingleLine(true);
        server.setText(prefs.getString(KEY_SERVER, "https://music.xminute.help"));
        root.addView(server, matchWrap());

        root.addView(text("设备 Token（只需 player:control）", 14));
        token = new EditText(this);
        token.setSingleLine(true);
        token.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        token.setText(prefs.getString(KEY_TOKEN, ""));
        root.addView(token, matchWrap());

        Button save = new Button(this);
        save.setText("保存配置");
        save.setOnClickListener(v -> save());
        root.addView(save, matchWrap());

        Button permission = new Button(this);
        permission.setText("开启通知使用权");
        permission.setOnClickListener(v -> startActivity(new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)));
        root.addView(permission, matchWrap());

        status = text("状态：" + prefs.getString(KEY_STATUS, "等待配置"), 14);
        root.addView(status);
        setContentView(root);
    }

    @Override protected void onResume() {
        super.onResume();
        if (status != null) status.setText("状态：" + getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_STATUS, "等待播放"));
    }

    private void save() {
        String url = server.getText().toString().trim().replaceAll("/+$", "");
        String secret = token.getText().toString().trim();
        if (!url.startsWith("https://")) {
            Toast.makeText(this, "服务器必须使用 https://", Toast.LENGTH_LONG).show();
            return;
        }
        if (secret.length() < 20) {
            Toast.makeText(this, "请填写设备 Token", Toast.LENGTH_LONG).show();
            return;
        }
        getSharedPreferences(PREFS, MODE_PRIVATE).edit()
            .putString(KEY_SERVER, url)
            .putString(KEY_TOKEN, secret)
            .apply();
        Toast.makeText(this, "已保存，播放网易云歌曲后会自动上报", Toast.LENGTH_LONG).show();
    }

    private TextView text(String value, int sp) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(sp);
        view.setPadding(0, dp(8), 0, dp(8));
        return view;
    }

    private LinearLayout.LayoutParams matchWrap() {
        return new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
}
