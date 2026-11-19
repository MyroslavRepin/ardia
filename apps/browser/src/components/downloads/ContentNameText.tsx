import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Animated, StyleSheet, View } from "react-native";
import { curve, nativeLoop } from "../ui/motion";
import { reduceMotion } from "../ui/reduceMotion";
import { CONTENT_NAME_MOTION as M } from "./tokens";

type Paint = "base" | "lit";

export function ContentNameText({ name, thinking, renames, children }: { name: string; thinking: boolean; renames: boolean; children: (text: string, paint: Paint) => ReactNode }) {
  const [width, setWidth] = useState(0);
  const leaving = useMorph(name, renames);
  return (
    <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      <Animated.View style={leaving ? leaving.entering : undefined}>{children(name, "base")}</Animated.View>
      {leaving ? (
        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, leaving.leaving]}>
          {children(leaving.text, "base")}
        </Animated.View>
      ) : null}
      {thinking && width > 0 ? <Shimmer width={width}>{children(name, "lit")}</Shimmer> : null}
    </View>
  );
}

function useMorph(name: string, renames: boolean) {
  const shown = useRef(name);
  const t = useRef(new Animated.Value(1)).current;
  const [leaving, setLeaving] = useState<string | null>(null);
  useLayoutEffect(() => {
    const before = shown.current;
    shown.current = name;
    if (!renames || !before || before === name) return;
    setLeaving(before);
    t.setValue(0);
    const morph = Animated.timing(t, { toValue: 1, duration: M.morphMs, easing: curve.enter, useNativeDriver: true });
    morph.start(({ finished }) => finished && setLeaving(null));
    return () => morph.stop();
  }, [name, renames, t]);
  if (!leaving) return null;
  const still = reduceMotion() !== false;
  const lift = still ? 0 : M.morphLift;
  return {
    text: leaving,
    leaving: {
      opacity: t.interpolate({ inputRange: [0, M.leaveShare, 1], outputRange: [1, 0, 0] }),
      transform: [{ translateY: t.interpolate({ inputRange: [0, 1], outputRange: [0, -lift] }) }],
    },
    entering: {
      opacity: t.interpolate({ inputRange: [0, M.enterDelayShare, 1], outputRange: [0, 0, 1] }),
      transform: [{ translateY: t.interpolate({ inputRange: [0, 1], outputRange: [lift, 0] }) }],
    },
  };
}

function Shimmer({ width, children }: { width: number; children: ReactNode }) {
  const t = useRef(new Animated.Value(0)).current;
  const still = reduceMotion() !== false;
  useEffect(() => {
    const loop = still
      ? nativeLoop(t, [
          { to: 1, ms: M.sweepMs / 2, easing: curve.pulse },
          { to: 0, ms: M.sweepMs / 2, easing: curve.pulse },
        ])
      : nativeLoop(t, [
          { to: 1, ms: M.sweepMs, easing: curve.move },
          { to: 1, ms: M.restMs },
        ]);
    loop.start();
    return () => loop.stop();
  }, [t, still]);
  if (still) {
    return (
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { opacity: t.interpolate({ inputRange: [0, 1], outputRange: [0, M.pulseOpacity] }) }]}>
        {children}
      </Animated.View>
    );
  }
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { overflow: "hidden" }]}>
      {M.bands.map((band) => (
        <Band key={band.width} t={t} width={width} band={band}>
          {children}
        </Band>
      ))}
    </View>
  );
}

function Band({ t, width, band, children }: { t: Animated.Value; width: number; band: { width: number; opacity: number }; children: ReactNode }) {
  const x = t.interpolate({ inputRange: [0, 1], outputRange: [-band.width, width] });
  return (
    <Animated.View style={{ position: "absolute", top: 0, bottom: 0, width: band.width, overflow: "hidden", opacity: band.opacity, transform: [{ translateX: x }] }}>
      <Animated.View style={{ width, transform: [{ translateX: Animated.multiply(x, -1) }] }}>{children}</Animated.View>
    </Animated.View>
  );
}
