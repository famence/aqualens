"use client";

import { useState } from "react";
import { Aqualens } from "@aqualens/react";

export interface GlassSettings {
  refraction: {
    thickness: number;
    factor: number;
    dispersion: number;
    fresnelRange: number;
    fresnelHardness: number;
    fresnelFactor: number;
  };
  glare: {
    range: number;
    hardness: number;
    factor: number;
    convergence: number;
    oppositeFactor: number;
    angle: number;
  };
  blurRadius: number;
  blurEdge: boolean;
  size: number;
  tintHex: string;
  tintAlpha: number;
}

export const DEFAULT_GLASS_SETTINGS: GlassSettings = {
  refraction: {
    thickness: 20,
    factor: 1.4,
    dispersion: 7,
    fresnelRange: 0,
    fresnelHardness: 0,
    fresnelFactor: 0,
  },
  glare: {
    range: 20,
    hardness: 20,
    factor: 30,
    convergence: 50,
    oppositeFactor: 80,
    angle: 0,
  },
  blurRadius: 0,
  blurEdge: true,
  size: 208,
  tintHex: "#ffffff",
  tintAlpha: 0,
};

const PANEL_REFRACTION = {
  thickness: 12,
  factor: 1.2,
  dispersion: 3,
  fresnelRange: 0,
  fresnelHardness: 0,
  fresnelFactor: 0,
};

const PANEL_GLARE = {
  range: 18,
  hardness: 12,
  factor: 22,
  convergence: 40,
  oppositeFactor: 60,
  angle: -45,
};

function formatValue(value: number, step: number): string {
  if (step >= 1) return String(Math.round(value));
  if (step >= 0.1) return value.toFixed(1);
  return value.toFixed(2);
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1.5 cursor-pointer group">
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-white/50 uppercase tracking-wider font-medium">
          {label}
        </span>
        <span className="text-[11px] text-white/30 tabular-nums font-mono">
          {formatValue(value, step)}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="slider-input"
      />
    </label>
  );
}

function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center justify-between py-0.5">
      <span className="text-[11px] text-white/50 uppercase tracking-wider font-medium">
        {label}
      </span>
      <div className="flex items-center gap-2">
        <div
          className="w-5 h-5 rounded-md border border-white/15 shadow-sm"
          style={{ backgroundColor: value }}
          aria-hidden
        />
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-7 w-10 p-0 bg-transparent border-0 cursor-pointer"
          aria-label={label}
        />
      </div>
    </div>
  );
}

function GlassSwitch({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between py-0.5">
      <span className="text-[11px] text-white/50 uppercase tracking-wider font-medium">
        {label}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={value}
        onClick={() => onChange(!value)}
        className={`relative w-11 h-6.5 rounded-full transition-all duration-300 border ${
          value
            ? "bg-white/20 border-white/25 shadow-[0_0_10px_rgba(255,255,255,0.12)]"
            : "bg-white/6 border-white/10"
        }`}
      >
        <span
          className={`absolute top-0.5 left-0.5 w-5.5 h-5.5 rounded-full transition-all duration-300 ${
            value
              ? "translate-x-4.5 bg-white shadow-[0_2px_8px_rgba(255,255,255,0.25)]"
              : "bg-white/40"
          }`}
        />
      </button>
    </div>
  );
}

function Section({
  title,
  defaultOpen = false,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="border-t border-white/6">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between py-2.5 text-left group/section"
      >
        <span className="text-[12px] font-semibold text-white/70 group-hover/section:text-white/90 transition-colors">
          {title}
        </span>
        <svg
          className={`w-3 h-3 text-white/30 transition-transform duration-200 ${
            open ? "rotate-180" : ""
          }`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2.5}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M19 9l-7 7-7-7"
          />
        </svg>
      </button>
      {open && <div className="flex flex-col gap-3 pb-3">{children}</div>}
    </div>
  );
}

export function GlassControls({
  settings,
  onChange,
  powerSave,
  onPowerSaveChange,
  mergeLens,
  onMergeLensChange,
  opaqueOverlap,
  onOpaqueOverlapChange,
}: {
  settings: GlassSettings;
  onChange: (s: GlassSettings) => void;
  powerSave: boolean;
  onPowerSaveChange: (v: boolean) => void;
  mergeLens: boolean;
  onMergeLensChange: (v: boolean) => void;
  opaqueOverlap: boolean;
  onOpaqueOverlapChange: (v: boolean) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);

  const updateRefraction = (
    key: keyof GlassSettings["refraction"],
    value: number,
  ) => {
    onChange({
      ...settings,
      refraction: { ...settings.refraction, [key]: value },
    });
  };

  const updateGlare = (key: keyof GlassSettings["glare"], value: number) => {
    onChange({
      ...settings,
      glare: { ...settings.glare, [key]: value },
    });
  };

  return (
    <div className="fixed right-4 top-4 z-100 hidden md:flex flex-col items-end gap-2 select-none">
      <Aqualens
        className="rounded-full shadow-lg bg-black/80"
        powerSave={powerSave}
        opaqueOverlap={opaqueOverlap}
        refraction={PANEL_REFRACTION}
        glare={PANEL_GLARE}
        blurRadius={0}
        blurEdge
      >
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="flex items-center gap-2 px-3.5 py-2 text-white/80 hover:text-white transition-colors text-xs font-medium"
        >
          <svg
            className="w-3.5 h-3.5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z"
            />
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"
            />
          </svg>
          Controls
        </button>
      </Aqualens>

      {!collapsed && (
        <Aqualens
          className="w-72 rounded-2xl shadow-2xl bg-black/80 z-11"
          powerSave={powerSave}
          opaqueOverlap={opaqueOverlap}
          refraction={PANEL_REFRACTION}
          glare={PANEL_GLARE}
          blurRadius={0}
          blurEdge
        >
          <div className="max-h-[calc(100vh-7rem)] overflow-y-auto overscroll-contain">
            <div className="px-4 pt-4 pb-1 flex items-baseline justify-between">
              <h3 className="text-[13px] font-semibold text-white/85 tracking-tight">
                Glass Controls
              </h3>
              <button
                type="button"
                onClick={() => onChange({ ...DEFAULT_GLASS_SETTINGS })}
                className="text-[10px] text-white/30 hover:text-white/60 uppercase tracking-widest transition-colors"
              >
                Reset
              </button>
            </div>

            <div className="px-4 pb-4">
              <div className="flex flex-col gap-2 pb-2 border-b border-white/6 mb-1">
                <GlassSwitch
                  label="Power Save"
                  value={powerSave}
                  onChange={onPowerSaveChange}
                />
                <GlassSwitch
                  label="Merge Lenses"
                  value={mergeLens}
                  onChange={onMergeLensChange}
                />
                <GlassSwitch
                  label="Opaque Overlap"
                  value={opaqueOverlap}
                  onChange={onOpaqueOverlapChange}
                />
              </div>

              <Section title="Refraction" defaultOpen>
                <Slider
                  label="Thickness"
                  value={settings.refraction.thickness}
                  min={1}
                  max={80}
                  step={0.1}
                  onChange={(v) => updateRefraction("thickness", v)}
                />
                <Slider
                  label="Factor"
                  value={settings.refraction.factor}
                  min={1}
                  max={4}
                  step={0.01}
                  onChange={(v) => updateRefraction("factor", v)}
                />
                <Slider
                  label="Dispersion"
                  value={settings.refraction.dispersion}
                  min={0}
                  max={50}
                  step={0.1}
                  onChange={(v) => updateRefraction("dispersion", v)}
                />
                <Slider
                  label="Fresnel Range"
                  value={settings.refraction.fresnelRange}
                  min={0}
                  max={100}
                  step={0.1}
                  onChange={(v) => updateRefraction("fresnelRange", v)}
                />
                <Slider
                  label="Fresnel Hardness"
                  value={settings.refraction.fresnelHardness}
                  min={0}
                  max={100}
                  step={0.1}
                  onChange={(v) => updateRefraction("fresnelHardness", v)}
                />
                <Slider
                  label="Fresnel Factor"
                  value={settings.refraction.fresnelFactor}
                  min={0}
                  max={100}
                  step={0.1}
                  onChange={(v) => updateRefraction("fresnelFactor", v)}
                />
              </Section>

              <Section title="Glare">
                <Slider
                  label="Range"
                  value={settings.glare.range}
                  min={0}
                  max={100}
                  step={0.1}
                  onChange={(v) => updateGlare("range", v)}
                />
                <Slider
                  label="Hardness"
                  value={settings.glare.hardness}
                  min={0}
                  max={100}
                  step={0.1}
                  onChange={(v) => updateGlare("hardness", v)}
                />
                <Slider
                  label="Factor"
                  value={settings.glare.factor}
                  min={0}
                  max={120}
                  step={0.1}
                  onChange={(v) => updateGlare("factor", v)}
                />
                <Slider
                  label="Convergence"
                  value={settings.glare.convergence}
                  min={0}
                  max={100}
                  step={0.1}
                  onChange={(v) => updateGlare("convergence", v)}
                />
                <Slider
                  label="Opposite Factor"
                  value={settings.glare.oppositeFactor}
                  min={0}
                  max={100}
                  step={0.1}
                  onChange={(v) => updateGlare("oppositeFactor", v)}
                />
                <Slider
                  label="Angle"
                  value={settings.glare.angle}
                  min={-180}
                  max={180}
                  step={1}
                  onChange={(v) => updateGlare("angle", v)}
                />
              </Section>

              <Section title="Blur">
                <Slider
                  label="Radius"
                  value={settings.blurRadius}
                  min={0}
                  max={200}
                  step={1}
                  onChange={(v) => onChange({ ...settings, blurRadius: v })}
                />
                <GlassSwitch
                  label="Edge Blur"
                  value={settings.blurEdge}
                  onChange={(v) => onChange({ ...settings, blurEdge: v })}
                />
              </Section>

              <Section title="Shape">
                <Slider
                  label="Size"
                  value={settings.size}
                  min={50}
                  max={500}
                  step={1}
                  onChange={(v) => onChange({ ...settings, size: v })}
                />
              </Section>

              <Section title="Tint">
                <ColorField
                  label="Color"
                  value={settings.tintHex}
                  onChange={(v) => onChange({ ...settings, tintHex: v })}
                />
                <Slider
                  label="Intensity"
                  value={settings.tintAlpha}
                  min={0}
                  max={1}
                  step={0.01}
                  onChange={(v) => onChange({ ...settings, tintAlpha: v })}
                />
              </Section>
            </div>
          </div>
        </Aqualens>
      )}
    </div>
  );
}
