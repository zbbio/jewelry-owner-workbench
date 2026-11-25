package com.zbbio.jewelryassistant.n14;

import java.time.Instant;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeFormatterBuilder;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.regex.Pattern;

/** A coarse native observation and its non-secret labels. Never a device or cable attestation. */
final class NetworkWitness {
    static final String SOURCE = "android_connectivity_manager";
    static final List<String> STAGES = Collections.unmodifiableList(Arrays.asList(
        "launch", "askA", "askB", "bVisible", "afterLateA", "noCard", "ownerReopen"
    ));
    private static final Pattern TEST = Pattern.compile("^N15-[A-Z0-9]{4,12}$");
    private static final Pattern TAIL = Pattern.compile("^[0-9a-f]{8}$");
    private static final DateTimeFormatter UTC = new DateTimeFormatterBuilder().appendInstant(3).toFormatter();

    enum Type { WIFI, CELLULAR, OTHER, NONE }

    static final class Reading {
        final Type type;
        final boolean validated;
        final boolean vpnActive;

        Reading(Type type, boolean validated, boolean vpnActive) {
            this.type = type;
            this.validated = validated;
            this.vpnActive = vpnActive;
        }
    }

    private NetworkWitness() {}

    static Reading unavailable() { return new Reading(Type.OTHER, false, false); }

    static Reading classify(boolean hasDefault, boolean stableCapabilities, boolean internet, boolean validated,
                            boolean vpn, boolean wifi, boolean cell, boolean otherTransport) {
        if (!hasDefault) return new Reading(Type.NONE, false, false);
        if (!stableCapabilities) return unavailable();
        Type kind = vpn || otherTransport || wifi == cell ? Type.OTHER : wifi ? Type.WIFI : Type.CELLULAR;
        return new Reading(kind, internet && validated, vpn);
    }

    static boolean needsTail(String stage) {
        return "bVisible".equals(stage) || "afterLateA".equals(stage);
    }

    static void validateLabels(String stage, String testNo, String requestTail) {
        if (!STAGES.contains(stage)) throw new IllegalArgumentException("未知取证阶段。");
        if (testNo == null || !TEST.matcher(testNo).matches())
            throw new IllegalArgumentException("请输入本轮公开测试编号：N15- 后接 4 至 12 位大写字母或数字。");
        if (needsTail(stage)) {
            if (requestTail == null || !TAIL.matcher(requestTail).matches())
                throw new IllegalArgumentException("仅填已经显示的 B 请求末 8 位小写十六进制。");
        } else if (requestTail != null) {
            throw new IllegalArgumentException("本阶段不填写请求尾号。");
        }
    }

    static String sampleJson(String stage, Instant at, String testNo, Reading reading, String requestTail) {
        validateLabels(stage, testNo, requestTail);
        if (at == null || reading == null) throw new IllegalArgumentException("缺少原生采样。");
        // Labels and enum are already strictly constrained ASCII before serializing.
        return "{\"stage\":\"" + stage + "\",\"utc\":\"" + UTC.format(at)
            + "\",\"source\":\"" + SOURCE + "\",\"testNo\":\"" + testNo
            + "\",\"networkType\":\"" + reading.type + "\",\"validated\":" + reading.validated
            + ",\"vpnActive\":" + reading.vpnActive + ",\"requestTail\":"
            + (requestTail == null ? "null" : "\"" + requestTail + "\"") + "}";
    }
}
