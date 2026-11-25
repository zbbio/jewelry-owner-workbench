package com.zbbio.jewelryassistant.n14;

import android.app.AlertDialog;
import android.content.Context;
import android.graphics.Color;
import android.text.InputType;
import android.view.View;
import android.widget.AdapterView;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.Spinner;
import android.widget.TextView;

import java.time.Instant;

/** Native-only, opt-in, in-memory display. No WebView references, bridge, upload, or logs. */
final class NetworkWitnessView extends LinearLayout {
    private final TextView receipt;
    private AlertDialog openForm;
    private String lastTestNo = "";

    NetworkWitnessView(Context context) {
        super(context);
        setOrientation(VERTICAL);
        setBackgroundColor(Color.rgb(242, 246, 239));
        Button button = new Button(context);
        button.setText("网络见证");
        button.setContentDescription("打开原生网络见证");
        button.setOnClickListener(v -> showForm());
        addView(button, new LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT));
        receipt = new TextView(context);
        receipt.setTextSize(12);
        receipt.setPadding(dp(8), 0, dp(8), dp(4));
        receipt.setSaveEnabled(false);
        receipt.setVisibility(View.GONE);
        addView(receipt, new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT));
    }

    private int dp(int x) {
        return Math.round(getResources().getDisplayMetrics().density * x);
    }

    private EditText newField(String prompt, boolean caps) {
        EditText e = new EditText(getContext());
        e.setSingleLine(true);
        e.setHint(prompt);
        e.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            | (caps ? InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS : 0));
        e.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO);
        e.setSaveEnabled(false);
        return e;
    }

    private void showForm() {
        final Context c = getContext();
        final LinearLayout form = new LinearLayout(c);
        form.setOrientation(VERTICAL);
        form.setPadding(dp(20), dp(6), dp(20), 0);
        TextView hint = new TextView(c);
        hint.setText("原生只采当前默认链路。输入公开编号；仅在 B 回执已显示后填写其尾号。USB 断线另行见证。");
        form.addView(hint);
        final Spinner stages = new Spinner(c);
        stages.setAdapter(new ArrayAdapter<>(c, android.R.layout.simple_spinner_dropdown_item, NetworkWitness.STAGES));
        form.addView(stages);
        final EditText test = newField("公开测试编号（N15-…）", true);
        test.setText(lastTestNo);
        form.addView(test);
        final EditText tail = newField("B 可见回执末 8 位（小写）", false);
        tail.setVisibility(View.GONE);
        form.addView(tail);
        stages.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
            @Override public void onItemSelected(AdapterView<?> parent, View view, int position, long id) {
                boolean required = NetworkWitness.needsTail(NetworkWitness.STAGES.get(position));
                if (!required) tail.setText("");
                tail.setVisibility(required ? View.VISIBLE : View.GONE);
            }
            @Override public void onNothingSelected(AdapterView<?> parent) {
                tail.setText("");
                tail.setVisibility(View.GONE);
            }
        });
        final AlertDialog d = new AlertDialog.Builder(c).setTitle("N15 网络见证 v2")
            .setView(form).setNegativeButton("关闭", null).setPositiveButton("原生采样", null).create();
        openForm = d;
        d.setOnDismissListener(x -> { if (openForm == d) openForm = null; });
        d.show();
        d.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> {
            final String stage = NetworkWitness.STAGES.get(stages.getSelectedItemPosition());
            final String testNo = test.getText().toString();
            final String requestTail = NetworkWitness.needsTail(stage) ? tail.getText().toString() : null;
            try {
                NetworkWitness.validateLabels(stage, testNo, requestTail);
                NetworkWitness.Reading reading = DefaultNetworkProbe.read(c);
                String serialized = NetworkWitness.sampleJson(stage, Instant.now(), testNo, reading, requestTail);
                lastTestNo = testNo;
                receipt.setText("原生采样（时点记录，不含 USB 见证）\n" + serialized);
                receipt.setVisibility(View.VISIBLE);
                d.dismiss();
            } catch (IllegalArgumentException badLabel) {
                if (NetworkWitness.needsTail(stage) && testNo.matches("N15-[A-Z0-9]{4,12}"))
                    tail.setError(badLabel.getMessage());
                else test.setError(badLabel.getMessage());
            }
        });
    }

    void clearEphemeral() {
        if (openForm != null) openForm.dismiss();
        lastTestNo = "";
        receipt.setText("");
        receipt.setVisibility(View.GONE);
    }
}
