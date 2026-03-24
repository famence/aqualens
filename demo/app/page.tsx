"use client";

import Image from "next/image";
import { useCallback, useEffect, useState } from "react";
import { Aqualens } from "@aqualens/react";
import {
  GlassControls,
  DEFAULT_GLASS_SETTINGS,
  type GlassSettings,
} from "./components/GlassControls";

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const normalized = hex.trim().replace("#", "");
  const full =
    normalized.length === 3
      ? normalized
          .split("")
          .map((c) => c + c)
          .join("")
      : normalized;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return { r, g, b };
}

const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";

export default function DemoPage() {
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [powerSave, setPowerSave] = useState(false);
  const [mergeLens, setMergeLens] = useState(false);
  const [opaqueOverlap, setOpaqueOverlap] = useState(false);
  const [glassSettings, setGlassSettings] = useState<GlassSettings>(
    DEFAULT_GLASS_SETTINGS,
  );

  const handleMouseMove = useCallback((event: MouseEvent) => {
    setPosition({ x: event.clientX, y: event.clientY });
  }, []);

  useEffect(() => {
    setPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    window.addEventListener("mousemove", handleMouseMove);
    return () => window.removeEventListener("mousemove", handleMouseMove);
  }, [handleMouseMove]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    if (powerSave) {
      root.setAttribute("data-liquid-power-save", "true");
    } else {
      root.removeAttribute("data-liquid-power-save");
    }
  }, [powerSave]);

  const tintRgb = hexToRgb(glassSettings.tintHex) ?? { r: 255, g: 255, b: 255 };

  return (
    <>
      <div className="relative space-y-12 p-6">
        <section
          className="relative h-[calc(100svh-12*4px)] snap-start snap-always"
          aria-hidden
        >
          <Image
            src={`${basePath}/bg-tahoe-light.webp`}
            alt=""
            fill
            sizes="100vw"
            priority
            className="object-cover rounded-3xl"
            quality={100}
          />
          <div className="absolute inset-0 flex items-center justify-center">
            <h1 className="text-4xl font-bold text-white text-center uppercase">
              Ultimate
              <br />
              liquid glass
              <br />
              experience
              <br />
              for the web
            </h1>
          </div>
        </section>

        <section
          className="relative h-[calc(100svh-12*4px)] snap-start snap-always"
          aria-hidden
        >
          <Image
            src={`${basePath}/dark-abstraction.png`}
            alt=""
            fill
            sizes="100vw"
            priority
            className="object-cover rounded-3xl"
            quality={100}
          />
        </section>

        <section
          className="relative h-[calc(100svh-12*4px)] overflow-hidden rounded-3xl bg-[#090d1a] snap-start snap-always"
          aria-label="Reveal demo"
        >
          <Image
            src={`${basePath}/bg-tahoe-light.webp`}
            alt=""
            fill
            sizes="100vw"
            className="object-cover opacity-40"
            quality={100}
          />
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_20%,rgba(111,177,255,0.35),transparent_55%),radial-gradient(circle_at_80%_70%,rgba(206,113,255,0.25),transparent_60%)]" />

          <div className="relative z-10 flex h-full flex-col justify-between p-10">
            <p className="text-xs tracking-[0.35em] uppercase text-white/70">
              Reveal Mode
            </p>

            <h2
              data-liquid-reveal
              className="text-7xl md:text-8xl font-black uppercase leading-[0.9] text-white"
            >
              only under
              <br />
              the lens
            </h2>

            <div />
          </div>
        </section>

        <section
          className="relative h-[calc(100svh-12*4px)] snap-start snap-always"
          aria-hidden
        >
          <video
            src="https://4so55dlz8lhqd9wz.public.blob.vercel-storage.com/bg-video.mp4"
            crossOrigin="anonymous"
            autoPlay
            loop
            muted
            playsInline
            className="absolute inset-0 object-cover w-full h-full rounded-3xl"
          />
          <Aqualens
            className="absolute inset-[50%] translate-x-[-50%] translate-y-[-50%] shadow-lg z-10 w-80 h-80 rounded-4xl bg-black/50"
            opaqueOverlap={opaqueOverlap}
            refraction={{
              thickness: 20,
              factor: 1.4,
              dispersion: 7,
              fresnelRange: 0,
              fresnelHardness: 0,
              fresnelFactor: 0,
            }}
            glare={{
              range: 20,
              hardness: 20,
              factor: 30,
              convergence: 50,
              oppositeFactor: 80,
              angle: 0,
            }}
            blurRadius={10}
            blurEdge
            powerSave={powerSave}
          >
            <div className="p-8 h-full flex flex-col items-start justify-between text-white">
              <p className="text-xs tracking-[0.35em] uppercase text-white/70">
                Video Support
              </p>
              <p className="text-white leading-10 uppercase font-black tracking-widest w-full block text-justify [text-align-last:justify]">
                <span className="text-5xl">It works</span>{" "}
                <span className="text-2xl text-black bg-white rounded-lg p-2">
                  over the video
                </span>{" "}
                <span className="text-5xl">as well</span>
              </p>
              <div />
            </div>
          </Aqualens>
        </section>

        <section className="relative h-[calc(100svh-12*4px)] flex items-center justify-center snap-start snap-always">
          <Image
            src={`${basePath}/macos-sequoia-minimal-pixel-art.png`}
            alt=""
            fill
            sizes="100vw"
            className="object-cover rounded-3xl"
            quality={100}
          />
          <p className="text-white relative">
            Scroll down — the glass stays centered, with content changing behind
            it.
          </p>
        </section>
      </div>

      <Aqualens
        className="glass-scroll-shape shadow-lg/10 z-10 pointer-events-none"
        opaqueOverlap={opaqueOverlap}
        powerSave={powerSave}
        style={{
          position: "fixed",
          left: "50%",
          top: "50%",
          transform: "translate(-50%, -50%)",
          willChange: "transform",
        }}
      />

      <Aqualens
        className={`pointer-events-none rounded-full shadow-lg hidden md:block ${mergeLens ? "z-10" : "z-30"}`}
        opaqueOverlap={opaqueOverlap}
        refraction={glassSettings.refraction}
        glare={glassSettings.glare}
        blurRadius={glassSettings.blurRadius}
        blurEdge={glassSettings.blurEdge}
        powerSave={powerSave}
        style={{
          position: "fixed",
          left: position.x,
          top: position.y,
          width: glassSettings.size,
          height: glassSettings.size,
          transform: "translate(-50%, -50%)",
          willChange: "transform",
          backgroundColor: `rgba(${tintRgb.r}, ${tintRgb.g}, ${tintRgb.b}, ${glassSettings.tintAlpha})`,
        }}
      />

      <GlassControls
        settings={glassSettings}
        onChange={setGlassSettings}
        powerSave={powerSave}
        onPowerSaveChange={setPowerSave}
        mergeLens={mergeLens}
        onMergeLensChange={setMergeLens}
        opaqueOverlap={opaqueOverlap}
        onOpaqueOverlapChange={setOpaqueOverlap}
      />
    </>
  );
}
