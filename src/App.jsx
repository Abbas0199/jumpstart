/**
 * ============================================================================
 *  ECU LAB — an engine management / tuning simulator
 * ============================================================================
 *
 *  WHAT THIS IS
 *  A teaching simulator. The player designs an engine, edits the same three
 *  calibration tables a real tuner edits (airflow, spark, fuel), runs a dyno
 *  pull, and reads a log explaining what went right or wrong. There is also a
 *  live engine that idles, revs and can stall in real time.
 *
 *  DESIGN RULE
 *  Nothing "adds horsepower". Every part changes airflow, pressure, temperature
 *  or fuel delivery, and power is whatever falls out of the physics. If you add
 *  a feature, add it as a physical mechanism, not as a bonus multiplier.
 *
 *  UNITS — the simulation works in real engineering units throughout:
 *    pressure kPa · temperature K · air & fuel mass grams · time ms
 *    energy J · torque Nm internally (converted to lb-ft only for display)
 *    MEP values Pa · airflow g/s · power W (converted to hp for display)
 *
 *  MAP OF THIS FILE
 *    1. Tables & options        — the editable calibration data and part lists
 *    2. Physical constants      — real, cited values (gas constant, LHV, ...)
 *    3. COEFF                   — every empirical/tuned coefficient, in one place
 *    4. Small math helpers      — clamp, interpolation, run grouping
 *    5. Engine architecture     — bore/stroke/cam/spring -> derived properties
 *    6. Airflow model           — computeHardwareVE: hardware -> VE table
 *    7. Advisors                — what the hardware now wants vs. what you have
 *    8. Scoring                 — tuning score, engineer score, pull score
 *    9. Core physics            — evaluatePoint: one operating point, fully solved
 *   10. Dyno sweep              — simulateSweep: a pull + the event log
 *   11. Live engine             — real-time crank dynamics + ECU control loop
 *   12. UI                      — design tokens, components, screens
 *
 *  WHERE TO START IF YOU ARE NEW
 *    - evaluatePoint() is the heart of it. Everything else feeds it or displays
 *      its output. It is commented step by step in the order an ECU works.
 *    - To change how the engine behaves, adjust COEFF — not the formulas.
 *    - To add a part, add it to the option list and make it change VE, knock
 *      margin, or fuel delivery. Never make it add power directly.
 *
 *  SOURCES — the physics here is standard textbook material, not invented:
 *    Otto cycle relations, p/T vs compression ratio, work and power
 *      NASA Glenn, Beginners Guide to Aeronautics — Internal Combustion Engine
 *      (Otto Cycle) and Engine Thermodynamic Analysis
 *      www1.grc.nasa.gov/beginners-guide-to-aeronautics/
 *    Engine fundamentals, VE, MEP, torque/power relations
 *      x-engineer.org/internal-combustion-engine/
 *    Thermodynamic efficiency limits of heat engines
 *      MIT OCW 8.21 The Physics of Energy, Lecture 11
 *    Practical engine maths worked longhand
 *      Hot Rod, "Basic Engine Physics & Math"
 *
 *  All formulas were checked for dimensional consistency: air density resolves to
 *  1.185 kg/m3 at sea level and 25 C against a 1.184 reference, and cycle time
 *  derives exactly from two crank revolutions.
 *
 *  TESTING
 *    The simulation is pure functions with no React dependency, so it can be
 *    exercised in plain Node by exporting from this file. Physics changes should
 *    be checked against a before/after fingerprint of several engine
 *    configurations rather than a single dyno number.
 * ============================================================================
 */

import React, { useState, useMemo, useEffect, useRef } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { Gauge, Grid3x3, Zap, Droplets, Wind, Activity, RotateCcw, Play, AlertTriangle, Info, Wrench, Settings, Package, Flame, ChevronDown, Trophy, TrendingUp, BookOpen, Fuel, Flag } from 'lucide-react';

// ============================================================
// ENGINE ARCHITECTURE — bore, stroke, compression, materials and
// configuration are player-editable and feed real physics below,
// the way Automation's engine designer works. Nothing here names
// a real production engine.
// ============================================================
// Real ECU tables include an idle breakpoint — without one, idle has to borrow the
// lowest cruise cell, which forces a wrong value into a cell that should hold cruise
// advance. 800 RPM is the idle row.
// Bump this whenever the build changes. It is shown on the start screen and in
// the header so a tester can confirm which version they are actually running.
const BUILD_VERSION = 'v4.8';

// ============================================================
// 1. TABLES & OPTIONS — the calibration data the player edits,
//    and the hardware they can choose from.
// ============================================================
const RPM = [800, 1500, 2500, 3500, 4500, 5500, 6500, 7500];
// LOAD AXIS = MANIFOLD ABSOLUTE PRESSURE in kPa, the axis real speed-density ECUs
// actually use (HP Tuners indexes VE by RPM x MAP; throttle-% indexing is "Alpha-N",
// the uncommon older method). ~101 kPa is atmospheric, so the top two rows are only
// reached under boost, and low rows are part-throttle vacuum.
const LOAD = [200, 150, 100, 70, 40, 20];

const DEFAULT_VE = [
  [60, 70, 84, 95, 104, 101, 94, 84],
  [58, 68, 82, 93, 102, 99, 92, 82],
  [55, 65, 78, 88, 96, 92, 85, 75],
  [49, 58, 70, 80, 87, 84, 77, 68],
  [38, 45, 55, 63, 69, 66, 61, 53],
  [29, 34, 42, 48, 52, 50, 46, 40],
];
const DEFAULT_TIMING = [
  [10, 14, 20, 26, 30, 32, 33, 34],
  [10, 14, 20, 26, 30, 32, 33, 34],
  [10, 14, 20, 26, 30, 32, 33, 34],
  [14, 22, 28, 33, 36, 37, 38, 39],
  [16, 30, 36, 40, 42, 43, 43, 43],
  [14, 34, 40, 44, 46, 47, 47, 47],
];
const DEFAULT_AFR = [
  [13.2, 12.8, 12.6, 12.6, 12.6, 12.8, 13.0, 13.2],
  [13.2, 12.8, 12.6, 12.6, 12.6, 12.8, 13.0, 13.2],
  [13.2, 12.8, 12.6, 12.6, 12.6, 12.8, 13.0, 13.2],
  [14.5, 14.0, 13.8, 13.6, 13.6, 13.8, 14.0, 14.2],
  [14.7, 14.7, 14.7, 14.7, 14.7, 14.7, 14.7, 14.7],
  [14.7, 14.7, 14.7, 14.7, 14.7, 14.7, 14.7, 14.7],
];
const DEFAULT_BOOST = [0, 0, 0, 0, 0, 0, 0, 0];
const DEFAULT_ENGINE_CONFIG = { configuration: 'V6', bore: 95.5, stroke: 81.4, compression: 10.3, blockMaterial: 'Aluminum', headMaterial: 'Aluminum', camDuration: 210, springRate: 50 };
const DEFAULT_MODS = { intake: false, exhaust: false, headers: false, intercooler: false };

// Base knock-limited timing envelope at WOT, 91 octane, N/A, no boost, calibrated
// against a naturally-aspirated ~3.5L, ~10.3:1, aluminum-head V6 baseline — the
// architecture panel then adjusts this up or down from what you actually build.
const BASE_KNOCK_LIMIT_91 = [20, 22, 26, 30, 33, 35, 37, 39];

// ============================================================
// PHYSICAL CONSTANTS — the sim now works in real engineering units
// (grams of air per cylinder per cycle, injector pulse width in ms,
// joules of fuel energy) rather than dimensionless indices, so the
// numbers it reports are the same ones a real ECU and dyno report.
// ============================================================
// ============================================================
// 2. PHYSICAL CONSTANTS — real measured values, not tuning knobs.
// ============================================================
const R_AIR = 287;          // specific gas constant for air, J/(kg·K)
const BARO_KPA = 101.325;   // sea-level ambient
const AMBIENT_K = 298;      // 25 °C ambient
const PSI_TO_KPA = 6.895;
const GAMMA_EXP = 0.286;    // (γ−1)/γ for air
const COMP_ISEN_EFF = 0.70; // typical turbo compressor isentropic efficiency
const IC_EFFECTIVENESS = 0.70;
const OTTO_REALIZATION = 0.759; // fraction of ideal Otto realised as INDICATED work
const DRIVETRAIN_EFF = 0.85;   // crank → wheel
const INJ_DEADTIME_MS = 1.0;   // injector opening latency at ~13.5V
const CHAR_SCALE = 0.3; // how strongly bore:stroke ratio biases the powerband

// ============================================================
// CALIBRATION COEFFICIENTS
// ------------------------------------------------------------
// Every empirically-tuned number in the simulation lives here, in one place, so a
// contributor can find and adjust the model without hunting through formulas.
// Each is annotated with what it represents and roughly why it has the value it has.
// Nothing below this block should contain a bare magic number.
// ============================================================
const COEFF = {
  // --- Friction & pumping (mean effective pressures, Pa) ---
  RUBBING_BASE_PA: 45000,      // rubbing FMEP at zero RPM
  RUBBING_PER_RPM: 6.5,        // rubbing FMEP rise per RPM
  SPRING_FMEP_PER_RATE: 190,   // extra FMEP per point of valve spring rate above stock
  SPRING_RPM_BIAS: 0.6,        // how much of spring drag scales with RPM (rest is constant)

  // --- Combustion efficiency roll-off ---
  // Torque falls as a parabola either side of MBT. 0.0016 gives roughly a 4% loss at
  // 5 deg from MBT, which matches published spark-sweep curves closely enough.
  TIMING_FALLOFF: 0.0016,
  // Same idea for mixture: ~2% loss one full AFR point off best power.
  AFR_FALLOFF: 0.022,
  EFFICIENCY_FLOOR: 0.55,      // neither term is allowed to drive output below this

  // --- Knock envelope (all in crank degrees) ---
  KNOCK_CHARGE_GAIN: 14,       // deg of margin gained/lost per unit of charge index
  KNOCK_CHARGE_RATIO_GAIN: 10, // deg gained as charge falls below reference (inverse law)
  KNOCK_CHARGE_REF: 0.90,      // charge index treated as the calibration reference point
  KNOCK_LEAN_PENALTY: 2.5,     // deg lost per AFR point leaner than best power
  KNOCK_RICH_BONUS: 1.0,       // deg gained per AFR point richer (capped)
  KNOCK_RICH_CAP: 2,
  KNOCK_IAT_PER_C: 0.08,       // deg lost per degree C of charge temp above ambient
  KNOCK_OVERBOOST_PENALTY: 1.5,// deg lost per psi past the compressor's efficient range
  MAX_KNOCK_RETARD: 18,        // most a real ECU will accumulate before giving up

  // --- Wear rates (percent of component life per pull) ---
  WEAR_KNOCK: 0.06,            // per degree of retard, per logged point
  WEAR_LEAN: 0.15,
  WEAR_VALVE_LEAN_BOOST: 0.4,
  WEAR_RICH_BORE_WASH: 0.9,    // per unit of lambda below the rich threshold
  WEAR_BEARING_PER_PSI: 0.10,

  // --- Camshaft & valvetrain ---
  CAM_PEAK_SHIFT_PER_DEG: 32,  // RPM the VE peak moves per degree of extra duration
  CAM_OVERLAP_PER_DEG: 0.55,   // overlap degrees gained per degree of duration
  CAM_FLOW_GAIN_PER_DEG: 0.0015,
  FLOAT_BASE_RPM: 7950,        // float speed at stock cam and stock springs
  FLOAT_PER_SPRING_RATE: 58,
  FLOAT_PER_CAM_DEG: 14,
  FLOAT_COLLAPSE_RPM: 1100,    // RPM band over which filling collapses past float
  FLOAT_COLLAPSE_FLOOR: 0.30,

  // --- Mixture targets ---
  BEST_AFR_NA: 12.85,          // lambda ~0.87, mid of the published best-torque band
  BEST_AFR_BOOST_SHIFT: 0.08,  // AFR richer per psi of boost
  BEST_AFR_BOOST_CAP: 0.65,    // richest the target is allowed to shift (lambda ~0.83)
  RICH_DAMAGE_LAMBDA: 0.75,    // below this under load, unburnt fuel starts causing harm
  LEAN_DAMAGE_AFR: 15.2,

  // --- Idle control (live engine) ---
  IDLE_AIR_GAIN_UP: 0.012,     // air is added far faster than removed (dashpot)
  IDLE_AIR_GAIN_DOWN: 0.0008,
  IDLE_AIR_DAMP: 0.004,
  IDLE_SPARK_GAIN: 0.022,      // spark gives instant torque authority; air is slow
  IDLE_SPARK_LIMIT: 14,
  IDLE_BLEED_RATE: 0.06,       // how fast the idle valve returns to base off-idle

  // --- Volumetric efficiency modifiers ---
  VE_PER_COMPRESSION_POINT: 0.005, // less clearance volume = less residual dilution
  VE_ALUMINIUM_HEAD_GAIN: 1.015,   // cooler chamber = denser incoming charge
  VE_E85_CHARGE_COOLING: 1.03,     // high latent heat of vaporisation densifies charge
  VE_EXHAUST_UNDERSIZE: 0.08,      // top-end VE lost per inch undersized
  VE_EXHAUST_OVERSIZE: 0.05,       // low-end VE lost per inch oversized (scavenging)
  VE_TURBINE_BACKPRESSURE: 0.97,   // baseline cost of having a turbine in the stream

  // --- Fuel trims ---
  STFT_GAIN: 42,
  LTFT_LEARN_RATE: 0.004,
  TRIM_LIMIT: 25,
};

const CYL_COUNT = { I4: 4, V6: 6, V8: 8 };
const CONFIG_OPTS = ['I4', 'V6', 'V8'];
const MATERIAL_OPTS = ['Cast Iron', 'Aluminum'];

// Octane raises the knock ceiling. Separately, a fuel's STOICHIOMETRIC POINT sets how
// much fuel volume is needed for the same lambda: gasoline is ~14.7:1, E85 is ~9.8:1,
// so E85 needs roughly 1.43x the injector flow for an identical lambda target. That is
// why E85 is not a free upgrade — it buys big knock margin but costs fuel system
// headroom, and undersized injectors will run out much sooner on it.
// Each fuel carries its real stoichiometric ratio, liquid density and lower heating
// value. Fuel MASS is derived from air mass and lambda; injector VOLUME from density;
// released ENERGY from LHV. E85 needs ~1.5x the volume of gasoline at the same lambda
// but has ~2/3 the energy per kg — those two nearly cancel, which is exactly why E85
// makes similar power per unit of air while demanding a much bigger fuel system.
const OCTANE_OPTS = [
  { label: '91', bonus: 0, stoich: 14.7, density: 0.745, lhv: 44.0e6 },
  { label: '93', bonus: 3, stoich: 14.7, density: 0.745, lhv: 44.0e6 },
  { label: '100', bonus: 8, stoich: 14.6, density: 0.750, lhv: 43.5e6 },
  { label: 'E85', bonus: 14, stoich: 9.8, density: 0.782, lhv: 29.2e6 },
];
// Real static flow ratings. Duty cycle is now computed from actual required pulse
// width against the time available per engine cycle, not a capacity index.
const INJECTOR_OPTS = [
  { label: '315cc (stock)', cc: 315 },
  { label: '440cc', cc: 440 },
  { label: '550cc', cc: 550 },
  { label: '650cc', cc: 650 },
  { label: '850cc', cc: 850 },
];
// Turbine sizing trades spool speed against top-end flow — small spins up fast but
// chokes the exhaust side at high RPM; large is laggy but flows more up top.
const TURBINE_OPTS = [
  { label: 'Small — quick spool', spoolRange: 1200, topEndMult: -0.05 },
  { label: 'Medium — balanced', spoolRange: 1800, topEndMult: 0 },
  { label: 'Large — top-end', spoolRange: 2600, topEndMult: 0.05 },
];
// Compressor sizing sets a practical boost ceiling before it's pushed outside its
// efficient range (surge/choke) — running past it makes hot, knock-prone air.
const COMPRESSOR_OPTS = [
  { label: 'Small', boostCeiling: 12, lagAdd: -150 },
  { label: 'Medium', boostCeiling: 20, lagAdd: 0 },
  { label: 'Large', boostCeiling: 30, lagAdd: 250 },
];
// Exhaust diameter isn't simply "bigger is better" — undersized chokes high-RPM
// flow, oversized loses low-RPM scavenging velocity. Ideal scales with displacement.
const EXHAUST_DIA_OPTS = [
  { label: '2.5"', dia: 2.5 },
  { label: '3.0"', dia: 3.0 },
  { label: '3.5"', dia: 3.5 },
  { label: '4.0"', dia: 4.0 },
];

// Real exhaust sizing follows POWER, not displacement alone — the long-standing
// shop rule is about one inch of total pipe diameter per 100 crank horsepower.
// Boost roughly scales power with pressure ratio, so a boosted build genuinely
// needs more pipe than the same engine naturally aspirated.
function idealExhaustDiameter(displacementL, peakBoostPsi = 0) {
  const naCrankHp = displacementL * 82;
  const estCrankHp = naCrankHp * (1 + Math.max(0, peakBoostPsi) / 14.7);
  return clamp(estCrankHp / 100, 2.0, 5.0);
}
const MOD_BONUS = {
  intake: [0, 0, 0, 1, 2, 3, 3, 4],
  exhaust: [0, 0, 1, 2, 3, 4, 5, 6],
  headers: [0, 1, 2, 4, 6, 8, 9, 10],
};
const MOD_INFO = {
  intake: { label: 'Cold Air Intake', blurb: 'Mostly a top-end gain — but the larger MAF housing needs a rescale or it will run lean.' },
  exhaust: { label: 'Cat-Back Exhaust', blurb: 'Frees up mid-to-high RPM flow; modest gain, good sound.' },
  headers: { label: 'Long-Tube Headers', blurb: 'The biggest single N/A bolt-on gain, spread across the mid-to-upper range.' },
};

// ============================================================
// 4. SMALL MATH HELPERS
// ============================================================
const clone2D = (arr) => arr.map((r) => [...r]);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function heat(value, min, max) {
  const t = clamp((value - min) / (max - min), 0, 1);
  const hue = 214 - t * 214;
  return `hsl(${hue.toFixed(0)}, 68%, ${26 + t * 12}%)`;
}
function interp1(bp, vals, x) {
  if (x <= bp[0]) return vals[0];
  if (x >= bp[bp.length - 1]) return vals[vals.length - 1];
  for (let i = 0; i < bp.length - 1; i++) {
    if (x >= bp[i] && x <= bp[i + 1]) {
      const t = (x - bp[i]) / (bp[i + 1] - bp[i]);
      return vals[i] + t * (vals[i + 1] - vals[i]);
    }
  }
  return vals[vals.length - 1];
}
function groupRuns(points, predicate) {
  const runs = [];
  let current = null;
  points.forEach((p, i) => {
    if (predicate(p)) { if (!current) current = { start: i, end: i }; else current.end = i; }
    else if (current) { runs.push(current); current = null; }
  });
  if (current) runs.push(current);
  return runs.map((r) => points.slice(r.start, r.end + 1));
}
// Best-power mixture is NOT a single number. Research and tuner practice put naturally
// aspirated best torque near lambda 0.85-0.92 (~12.5-13.5:1 on gasoline) and forced
// induction meaningfully richer, near lambda 0.82-0.85 (~12.0-12.5:1) — the extra fuel
// under boost is charge cooling, bought deliberately to hold off knock. This returns the
// gasoline-equivalent AFR that makes best power at a given boost level.
// Compressing air heats it. Real compressors are ~70% isentropically efficient, so
// charge temp rises faster than ideal. An intercooler recovers most of that back
// toward ambient. Charge temp then feeds BOTH air density (via ideal gas law) and
// knock margin — the same coupling that exists on a real engine.
function chargeTempK(boostPsi, intercooler) {
  if (boostPsi <= 0) return AMBIENT_K;
  const pressureRatio = (BARO_KPA + boostPsi * PSI_TO_KPA) / BARO_KPA;
  const tCompressed = AMBIENT_K * Math.pow(pressureRatio, GAMMA_EXP / COMP_ISEN_EFF);
  return intercooler ? AMBIENT_K + (tCompressed - AMBIENT_K) * (1 - IC_EFFECTIVENESS) : tCompressed;
}

// Manifold pressure is the real load signal. Throttle sets how much of atmospheric
// pressure reaches the manifold; boost adds on top of that. Everything downstream
// indexes off MAP, exactly as a speed-density ECU does.
// ============================================================
// CAMSHAFT & VALVE SPRINGS
// Duration is how long (in crank degrees) a valve stays open. A longer cam holds
// the intake valve open later into the compression stroke, so at low RPM some
// charge is pushed back out — but at high RPM the extra open time is exactly what
// lets the cylinder keep filling. That is why a big cam trades bottom end for top
// end and shifts the whole torque curve upward in RPM.
const CAM_BASE_DURATION = 210;

function camPeakShiftRpm(camDuration) {
  return (camDuration - CAM_BASE_DURATION) * COEFF.CAM_PEAK_SHIFT_PER_DEG; // where the VE peak moves to
}
// Valve overlap — both valves open together around TDC — scales with duration and
// is what makes a big cam idle rough and lose manifold vacuum.
function camOverlapDeg(camDuration) {
  return Math.max(0, (camDuration - CAM_BASE_DURATION) * COEFF.CAM_OVERLAP_PER_DEG);
}
// Springs must close the valve faster than the cam ramp as RPM climbs. Past their
// limit the valve "floats" — it stops following the lobe, so the cylinder cannot
// fill and power falls off a cliff. Bigger cams need stiffer springs.
function valveFloatRpm(springRate, camDuration) {
  return COEFF.FLOAT_BASE_RPM + (springRate - 50) * COEFF.FLOAT_PER_SPRING_RATE - (camDuration - CAM_BASE_DURATION) * COEFF.FLOAT_PER_CAM_DEG;
}
// Stiffer springs cost real parasitic power to compress, every cycle.
function springFrictionPa(springRate) {
  return Math.max(0, (springRate - 50) * COEFF.SPRING_FMEP_PER_RATE);
}

function computeManifold(rpm, loadKpa, turboOn, boostTarget, turbine, compressor) {
  const throttleFrac = clamp(loadKpa / BARO_KPA, 0, 1);
  const effectiveSpoolRange = Math.max(400, turbine.spoolRange + compressor.lagAdd);
  const spool = clamp((rpm - 1500) / effectiveSpoolRange, 0, 1);
  const boostPsi = turboOn ? boostTarget * spool * Math.pow(throttleFrac, 2) : 0;
  const mapKpa = Math.min(loadKpa, BARO_KPA) + boostPsi * PSI_TO_KPA;
  return { mapKpa, boostPsi, throttleFrac, spool };
}

function bestPowerAfr(boostPsi) {
  return COEFF.BEST_AFR_NA - clamp(boostPsi * COEFF.BEST_AFR_BOOST_SHIFT, 0, COEFF.BEST_AFR_BOOST_CAP);
}

function charMultiplier(rpm, ratio) {
  const norm = (rpm - 4500) / 3000; // -1 at 1500rpm, +1 at 7500rpm
  return 1 + (ratio - 1) * CHAR_SCALE * norm;
}

// Bore/stroke ratio bias is now baked directly into the VISIBLE VE table (not a
// hidden multiplier at sim time) — so changing bore/stroke on BUILD actually moves
// the numbers you see and edit on the VE tab, the way a real hardware change would
// show up the next time a tuner logs airflow. Uses the same validated bias formula
// that used to run invisibly inside evaluatePoint.
// ============================================================
// 6. AIRFLOW MODEL — hardware in, VE table out. This is the only
//    place hardware is allowed to change how the engine breathes.
// ============================================================
function computeHardwareVE(cfg, mods, hw = {}) {
  const { turboOn = false, turbine = null, exhaustDia = null, fuel = null } = hw;
  const ratio = cfg.bore / cfg.stroke;
  const cyl = CYL_COUNT[cfg.configuration];
  const displacementL = (Math.PI / 4 * Math.pow(cfg.bore / 10, 2) * (cfg.stroke / 10) * cyl) / 1000;
  const perCylL = displacementL / cyl;
  const idealDia = 2.2 + displacementL * 0.25;
  const diaError = exhaustDia != null ? exhaustDia - idealDia : 0;

  // Smaller individual cylinders carry proportionally more valve area for their
  // volume, so they keep filling better at high RPM. Big single cylinders fall off.
  const cylBreathing = clamp((0.62 - perCylL) * 0.10, -0.05, 0.05);

  // Higher compression means less clearance volume, so less burnt gas is left
  // behind to dilute the incoming charge — a small but real VE gain.
  const crFactor = 1 + (cfg.compression - 10.3) * COEFF.VE_PER_COMPRESSION_POINT;

  // An aluminium head runs cooler, so the incoming charge picks up less heat on
  // the way in and stays denser.
  const headFactor = cfg.headMaterial === 'Aluminum' ? COEFF.VE_ALUMINIUM_HEAD_GAIN : 1.0;

  // Fuels with high latent heat of vaporisation cool the charge as they evaporate,
  // which raises density. E85 is markedly better at this than gasoline.
  const fuelFactor = fuel ? (fuel.stoich < 12 ? COEFF.VE_E85_CHARGE_COOLING : fuel.stoich < 14.7 ? 1.005 : 1.0) : 1.0;

  // Camshaft: shifting where the VE peak sits is the honest way to model duration.
  // A longer cam is evaluated as if the engine were running SLOWER than it is, so
  // the whole breathing curve slides up the RPM range — top end gained, bottom lost.
  const camDuration = cfg.camDuration ?? CAM_BASE_DURATION;
  const springRate = cfg.springRate ?? 50;
  const camShift = camPeakShiftRpm(camDuration);
  const flowGain = 1 + (camDuration - CAM_BASE_DURATION) * COEFF.CAM_FLOW_GAIN_PER_DEG; // more open time = more flow area-seconds
  const floatRpm = valveFloatRpm(springRate, camDuration);

  return DEFAULT_VE.map((row, ri) => row.map((v, ci) => {
    const rpm = RPM[ci];
    const norm = (rpm - 4500) / 3000;      // -1 at 1500, +1 at 7500
    const loadScale = clamp(LOAD[ri] / BARO_KPA, 0, 1);

    // Sample the baseline breathing curve at the cam-shifted engine speed.
    const camRpm = clamp(rpm - camShift, 1200, 8200);
    const baseVe = interp1(RPM, row, camRpm);
    let val = baseVe * flowGain * charMultiplier(rpm, ratio);

    // Valve float: past the spring's limit the valve stops following the lobe and
    // cylinder filling collapses. This is the cliff you feel at the top of an
    // over-cammed, under-sprung engine.
    if (rpm > floatRpm) val *= clamp(1 - (rpm - floatRpm) / COEFF.FLOAT_COLLAPSE_RPM, COEFF.FLOAT_COLLAPSE_FLOOR, 1);
    val *= 1 + cylBreathing * Math.max(0, norm);
    val *= crFactor * headFactor * fuelFactor;

    // Bolt-ons: measured airflow gains, weighted toward the RPM where they work.
    if (mods.intake) val += MOD_BONUS.intake[ci] * loadScale;
    if (mods.exhaust) val += MOD_BONUS.exhaust[ci] * loadScale;
    if (mods.headers) val += MOD_BONUS.headers[ci] * loadScale;

    // Exhaust diameter: undersized chokes the top end, oversized kills low-RPM
    // scavenging velocity. Both directions cost VE, in different places.
    if (diaError < 0) val *= 1 + diaError * COEFF.VE_EXHAUST_UNDERSIZE * Math.max(0, norm);
    else if (diaError > 0) val *= 1 - diaError * COEFF.VE_EXHAUST_OVERSIZE * Math.max(0, -norm);

    // A turbine in the exhaust stream is a restriction. Small housings choke the
    // top end; large ones flow better up high but hurt low-RPM scavenging.
    if (turboOn && turbine) {
      val *= 1 + turbine.topEndMult * Math.max(0, norm);
      val *= COEFF.VE_TURBINE_BACKPRESSURE;
    }

    return Number(clamp(val, 10, 130).toFixed(1));
  }));
}

// In Manual mode the player's VE table is frozen while hardware changes around it.
// This compares what they have against what the current hardware would actually
// flow, and turns the gap into specific, cell-level tuning advice — the same thing
// a tuner would conclude after re-logging airflow following a parts change.
// ============================================================
// 7. ADVISORS — compare what the hardware now wants against what
//    the player's tables actually say. These never edit anything.
// ============================================================
function veRecommendations(currentVe, cfg, mods, hw) {
  const target = computeHardwareVE(cfg, mods, hw);
  const recs = [];
  const wotRow = 2; // the ~100 kPa (WOT, naturally aspirated) row
  const deltas = RPM.map((rpm, ci) => ({
    rpm,
    pct: ((target[wotRow][ci] - currentVe[wotRow][ci]) / Math.max(1, currentVe[wotRow][ci])) * 100,
    from: currentVe[wotRow][ci],
    to: target[wotRow][ci],
  }));

  const notable = deltas.filter((d) => Math.abs(d.pct) >= 2.5);
  if (notable.length === 0) {
    return { inSync: true, recs: [], deltas, maxAbs: Math.max(...deltas.map((d) => Math.abs(d.pct))) };
  }

  const low = notable.filter((d) => d.rpm <= 3500);
  const mid = notable.filter((d) => d.rpm > 3500 && d.rpm < 6500);
  const high = notable.filter((d) => d.rpm >= 6500);

  const band = (arr, name) => {
    if (!arr.length) return;
    const avg = arr.reduce((a, b) => a + b.pct, 0) / arr.length;
    const dir = avg > 0 ? 'raise' : 'lower';
    recs.push({
      band: name,
      rpmText: arr.length === 1 ? `${arr[0].rpm} RPM` : `${arr[0].rpm}–${arr[arr.length - 1].rpm} RPM`,
      pct: avg,
      text: `${dir === 'raise' ? 'Raise' : 'Lower'} the ${name} cells by about ${Math.abs(avg).toFixed(0)}% — your hardware ${avg > 0 ? 'now flows more air here than your table assumes' : 'flows less air here than your table assumes'}.`,
      cells: arr.map((d) => `${d.rpm} RPM: ${d.from} → ${d.to}`),
    });
  };
  band(low, 'low-RPM');
  band(mid, 'mid-range');
  band(high, 'top-end');

  return { inSync: false, recs, deltas, maxAbs: Math.max(...deltas.map((d) => Math.abs(d.pct))) };
}

// Turns bore/stroke/compression/materials/configuration into the physics deltas
// used by evaluatePoint. This is the whole "engine designer" payoff.
// ============================================================
// 5. ENGINE ARCHITECTURE — turns the player's short-block design
//    into the derived properties the physics needs.
// ============================================================
function deriveEngine(cfg) {
  const cyl = CYL_COUNT[cfg.configuration];
  const boreCm = cfg.bore / 10, strokeCm = cfg.stroke / 10;
  const displacementL = (Math.PI / 4 * boreCm * boreCm * strokeCm * cyl) / 1000;
  const ratio = cfg.bore / cfg.stroke;
  const perCylL = displacementL / cyl;
  const configKnockBonus = perCylL < 0.5 ? 1 : perCylL > 0.7 ? -1 : 0;
  const materialKnockBonus = cfg.headMaterial === 'Cast Iron' ? -1.5 : 0;
  const compressionKnockAdj = (10.3 - cfg.compression) * 2.0;
  // Thermal efficiency comes from the ideal Otto cycle for this compression ratio,
  // scaled by what real engines actually realize.
  // Air-standard Otto efficiency: eta = 1 - 1/r^(gamma-1).
  // NASA Glenn gives the underlying relation T3/T2 = r^(gamma-1); MIT 8.21 Lecture 11
  // gives the value to use: at 1500-2500 K the combustion products have gamma ~ 1.3,
  // producing eta_Otto ~ 0.50 at r ~ 10. Exponent 0.30 reproduces that exactly
  // (0.499 at r=10). gamma = 1.4 is the COLD-air-standard value and overstates
  // efficiency by ~20% here, so it is deliberately not used.
  const ottoIdeal = 1 - 1 / Math.pow(cfg.compression, 0.30);
  // INDICATED efficiency — work done on the piston, before friction and pumping
  // are paid for. Brake (usable) output is computed later as IMEP minus FMEP.
  const thermalEff = ottoIdeal * OTTO_REALIZATION;
  const torqueScale = displacementL / 3.5;
  const bearingWearMult = cfg.blockMaterial === 'Cast Iron' ? 0.85 : 1.0;
  const camDuration = cfg.camDuration ?? CAM_BASE_DURATION;
  const springRate = cfg.springRate ?? 50;
  const overlapDeg = camOverlapDeg(camDuration);
  const floatRpm = valveFloatRpm(springRate, camDuration);
  const springPa = springFrictionPa(springRate);
  const character = ratio > 1.08 ? 'Oversquare — revs and breathes higher' : ratio < 0.95 ? 'Undersquare — stronger low-end torque' : 'Square — balanced';
  return { cyl, displacementL, ratio, configKnockBonus, materialKnockBonus, compressionKnockAdj, thermalEff, ottoIdeal, torqueScale, bearingWearMult, character, perCylL, camDuration, springRate, overlapDeg, floatRpm, springPa };
}

// Hardware changes invalidate a CALIBRATION but do not rewrite it — that is real,
// and it is the central lesson of the app. So spark and fuel never auto-change.
// Instead this reports what the current hardware would actually tolerate, cell by
// cell, so the player can see where their tune has gone stale and fix it themselves.
function calibrationAdvice({ ve, timing, afr, derived, octaneBonus, fuel, mods, turboOn, boostCurve, compressor, turbine, injectorCc, ecuInjectorCc, mafScalar, mafErrorBase }) {
  const spark = [], fuelAdv = [];
  // Only advise on load the engine can actually reach. A naturally aspirated build
  // never sees 150 or 200 kPa, so flagging those rows would be pure noise.
  const maxReachable = BARO_KPA + (turboOn ? Math.max(...boostCurve) * PSI_TO_KPA : 0) + 2;
  LOAD.forEach((mapRow, ri) => {
    if (mapRow > maxReachable) return;
    RPM.forEach((rpm, ci) => {
      const boostTarget = turboOn ? interp1(RPM, boostCurve, rpm) : 0;
      const man = computeManifold(rpm, Math.min(mapRow, BARO_KPA), turboOn, boostTarget, turbine, compressor);
      const useMap = mapRow > BARO_KPA ? mapRow : man.mapKpa;
      const boostPsi = Math.max(0, (useMap - BARO_KPA) / PSI_TO_KPA);
      const pt = evaluatePoint({
        rpm, mapKpa: useMap, boostPsi, throttleFrac: clamp(useMap / BARO_KPA, 0, 1),
        veVal: ve[ri][ci], timingVal: timing[ri][ci], afrCommanded: afr[ri][ci],
        octaneBonus, fuel, mods: { ...mods, turboFitted: turboOn }, mafScalar, mafErrorBase,
        injectorCc, ecuInjectorCc, derived, compressor,
      });
      // Leave ~1.5 deg of safety under the calculated knock limit, as a tuner would.
      const safeTiming = Math.round((pt.threshold - 1.5) * 2) / 2;
      // If the knock limit has collapsed to near zero, retarding further is not the
      // answer — the load point itself is unsustainable. That happens when the
      // mixture has gone lean (usually injectors out of duty) or boost/heat is past
      // what the fuel can support. Say so instead of advising negative timing.
      const unsustainable = safeTiming < 2;
      spark.push({ ri, ci, rpm, map: mapRow, current: timing[ri][ci],
        suggested: unsustainable ? null : safeTiming,
        delta: unsustainable ? -99 : +(safeTiming - timing[ri][ci]).toFixed(1),
        knocking: pt.knock, unsustainable,
        cause: pt.fuelLimited ? 'injectors out of duty cycle'
          : pt.afr > pt.bestAfr + 0.6 ? 'mixture too lean for this pressure'
          : pt.iat > 90 ? 'charge air too hot — needs an intercooler'
          : 'boost is beyond what this octane supports' });
      fuelAdv.push({ ri, ci, rpm, map: mapRow, current: afr[ri][ci], suggested: +pt.bestAfr.toFixed(1),
        delta: +(pt.bestAfr - afr[ri][ci]).toFixed(1), duty: pt.duty });
    });
  });
  const overAdvanced = spark.filter((c) => c.delta < -1.0);
  const underAdvanced = spark.filter((c) => c.delta > 3.0);
  const wrongMix = fuelAdv.filter((c) => c.map >= 85 && Math.abs(c.delta) > 0.45);
  return { spark, fuelAdv, overAdvanced, underAdvanced, wrongMix };
}

// ============================================================
// CAREER JOBS
// ------------------------------------------------------------
// Each job hands the player a car with a specific, diagnosable fault and a target.
// The faults are the real ones the simulation already models — nothing is scripted,
// and every job is solved by actually understanding what the log is telling you.
// `setup` returns the state overrides applied when the job is taken on.
// `goal(result, ctx)` decides whether the job is complete after a pull.
// ============================================================
const CAREER_JOBS = [
  {
    id: 'rich-injectors',
    title: 'Runs terrible since the fuel upgrade',
    customer: 'Owner fitted bigger injectors himself. Says it now stinks of fuel, fouls plugs and feels gutless.',
    brief: 'Something is delivering far more fuel than the tables ask for. Run a pull, read the log, and find the cause rather than bending the fuel table around it.',
    target: 'Reach Tuning Score 90+ without touching the AFR table.',
    setup: { injIdx: 4, ecuInjectorCc: 315 },
    goal: (r, ctx) => ctx.tuningScore >= 90 && !r.events.some((e) => e.type === 'rich' || e.type === 'injscale'),
    teaches: 'The ECU calculates pulse width for the injector size it has been told is fitted. Hardware changed; the ECU was never told.',
  },
  {
    id: 'stale-ve',
    title: 'Cam swap, never re-logged',
    customer: 'Shop fitted a big cam and handed it back on the old calibration. Customer says it runs rough and lean up top.',
    brief: 'The engine breathes differently now. The VE table is still describing the old engine, so the ECU is fuelling for air that is not there.',
    target: 'Get the mixture back on target and reach Tuning Score 85+.',
    setup: { camDuration: 268, springRate: 78, staleVe: true },
    goal: (r, ctx) => ctx.tuningScore >= 85 && !r.events.some((e) => e.type === 'lean' || e.type === 'rich'),
    teaches: 'A VE table is a log of measured airflow. Change the hardware and that log is simply out of date.',
  },
  {
    id: 'untuned-turbo',
    title: 'Turbo kit, stock calibration',
    customer: 'Customer bolted on a turbo and drove it home. Says it pulls hard then goes flat and rattles under load.',
    brief: 'A factory naturally-aspirated calibration has nothing meaningful above atmospheric pressure. Everything above 101 kPa is your job.',
    target: 'Survive 8 psi with Tuning Score 85+ and no knock events.',
    setup: { turboOn: true, boostCurve: [0, 0, 3, 6, 8, 8, 8, 7], injIdx: 2, ecuInjectorCc: 550, octaneIdx: 1 },
    goal: (r, ctx) => ctx.tuningScore >= 85 && !r.events.some((e) => e.type === 'knock'),
    teaches: 'Boost raises cylinder pressure enormously. Spark has to come out and mixture has to come richer, in the boost rows specifically.',
  },
  {
    id: 'lean-intake',
    title: 'Intake fitted, now it hesitates',
    customer: 'Aftermarket intake went on last week. Customer reports poor economy and a stumble at part throttle.',
    brief: 'The airflow sensor is reading against a housing it was never calibrated for. Watch the fuel trims, not just the power number.',
    target: 'Clear the trim fault and reach Tuning Score 95+.',
    setup: { intake: true },
    goal: (r, ctx) => ctx.tuningScore >= 95 && !r.events.some((e) => e.type === 'maf'),
    teaches: 'Closed loop hides small airflow errors at cruise. At wide open throttle the ECU stops listening to the O2 sensor and the error passes straight through.',
  },
  {
    id: 'full-session',
    title: 'Fresh build, no calibration at all',
    customer: 'Engine shop finished a build and handed it over with the factory file still loaded. Nothing on it has been tuned.',
    brief: 'This is a complete session, and the order matters. Verify what is actually fitted, set the scaling constants, correct airflow, then set fuel, then spark — last and in small steps. Skip a step and you will be tuning on a wrong foundation.',
    target: 'Tuning 90+ with no knock, no mixture faults and no scaling errors. The cam advisory will remain — that is a hardware trade-off, not something calibration can remove.',
    setup: { camDuration: 252, springRate: 76, injIdx: 3, ecuInjectorCc: 315, intake: true, staleVe: true, octaneIdx: 1 },
    goal: (r, ctx) => ctx.tuningScore >= 90
      && !r.events.some((e) => ['knock', 'lean', 'rich', 'injscale', 'maf', 'fuel'].includes(e.type)),
    teaches: 'Real tuning is a sequence, not a set of independent knobs. Scaling first, then airflow, then fuel, then spark — because each step assumes the one before it is already right.',
  },
  {
    id: 'power-goal',
    title: 'Customer wants 320 whp, safely',
    customer: 'Track day car. Owner wants real power but has to finish the weekend — reliability matters more than a headline number.',
    brief: 'Build and calibrate whatever it takes. The constraint is that it has to be clean: no knock, no lean cells, nothing running out of fuel.',
    target: '320+ whp with Tuning Score 90+ and zero knock.',
    setup: {},
    goal: (r, ctx) => r.peakHp >= 320 && ctx.tuningScore >= 90 && !r.events.some((e) => e.type === 'knock'),
    teaches: 'Power is easy. Power that survives a weekend is the actual job.',
  },
];

// ============================================================
// SCORING — graded once per pull. Tuning Score reflects how clean
// the calibration is (fewer/less severe pull-log events = higher);
// Engineer Score reflects how coherent the BUILD hardware choices
// are with each other, independent of how well it is tuned.
// ============================================================
function computeTuningScore(result) {
  let score = 100;
  const deductions = [];
  result.events.forEach((e) => {
    const d = e.impact ?? 5;
    score -= d;
    deductions.push(`-${d}  ${e.msg}`);
  });
  score = clamp(Math.round(score), 0, 100);
  const label = score >= 90 ? 'Dialed In' : score >= 75 ? 'Solid' : score >= 55 ? 'Rough Edges' : score >= 30 ? 'Risky' : 'Dangerous';
  return { score, label, deductions };
}

function computeEngineerScore({ engineConfig, turboOn, turbine, compressor, exhaustDiaError, dutyPreview, displacementL }) {
  let score = 100;
  const deductions = [];
  if (turboOn && engineConfig.compression > 10.5) { score -= 15; deductions.push('-15 High static compression fights boost pressure'); }
  if (!turboOn && engineConfig.compression < 9.0) { score -= 10; deductions.push('-10 Low compression leaves naturally-aspirated efficiency on the table'); }
  const highHeat = engineConfig.compression > 11.5 || (turboOn && compressor.boostCeiling > 20);
  if (highHeat && engineConfig.headMaterial === 'Cast Iron') { score -= 10; deductions.push('-10 High heat load without an aluminum head for cooling'); }
  if (turboOn) {
    if (displacementL < 3.0 && (turbine.label.includes('Large') || compressor.label === 'Large')) { score -= 8; deductions.push('-8 Turbo sized large for this displacement — expect heavy lag'); }
    if (displacementL > 4.2 && (turbine.label.includes('Small') || compressor.label === 'Small')) { score -= 8; deductions.push('-8 Turbo sized small for this displacement — will choke the top end'); }
  }
  if (Math.abs(exhaustDiaError) > 0.3) { score -= 8; deductions.push('-8 Exhaust diameter poorly matched to displacement'); }
  if (dutyPreview > 95) { score -= 12; deductions.push('-12 Injectors undersized for current demand'); }
  score = clamp(Math.round(score), 0, 100);
  const label = score >= 90 ? 'Sound Engineering' : score >= 75 ? 'Reasonable' : score >= 55 ? 'Some Mismatches' : score >= 30 ? 'Poorly Matched' : 'Fighting Itself';
  return { score, label, deductions };
}

// PULL SCORE — the uncapped, competitive number. Tuning/Engineer scores above are
// 0-100 cleanliness grades (easy to read at a glance); Pull Score turns those grades
// into a points total that rewards actually making real power, not just staying
// clean at idle. A big, dirty pull can still out-score a small, spotless one — same
// tension a real tuner balances between safety margin and output.
function computePullScore({ peakHp, peakTq, tuningScore, engineerScore }) {
  const cleanlinessMult = 0.35 + 0.65 * (tuningScore / 100);
  const engineeringMult = 0.7 + 0.3 * (engineerScore / 100);
  const raw = (peakHp * 1.0 + peakTq * 0.6) * cleanlinessMult * engineeringMult;
  return Math.round(raw);
}

// ============================================================
// SIMULATION CORE — one pure function per RPM point, called in a
// loop by the full dyno sweep. Nothing here runs, and no result
// exists, until an actual pull is triggered — the sandbox never
// shows simulated outcomes without a pull behind them.
// ============================================================
// veVal      = the VE number in the PLAYER'S table. This is the ECU's *estimate* of
//              how well the cylinder fills, and it is what the ECU uses to decide
//              how much fuel to inject.
// veTrue     = what the hardware ACTUALLY flows. The engine breathes by this number
//              whether the ECU knows it or not.
// When the two disagree, the ECU fuels for the wrong amount of air and the mixture
// comes out wrong on the wideband. That gap is the entire reason VE tables get
// tuned, and it is what the fuel-trim histogram measures.
function evaluatePoint({ rpm, mapKpa, boostPsi, throttleFrac, veVal, veTrue, timingVal, afrCommanded,
                        octaneBonus, fuel, mods, mafScalar, mafErrorBase,
                        injectorCc, ecuInjectorCc, derived, compressor }) {
  const norm = (rpm - 4500) / 3000;
  const compressorOver = boostPsi > compressor.boostCeiling;
  const chargeK = chargeTempK(boostPsi, mods.intercooler);
  const chargeC = chargeK - 273.15;

  // --- AIR CHARGE: ideal gas law. MAP already carries load, so VE is used purely
  // as an efficiency term here — no separate throttle multiplier (that would
  // double-count load, which is exactly the Alpha-N mistake).
  const vCylM3 = (derived.displacementL / derived.cyl) / 1000;
  const airDensity = (mapKpa * 1000) / (R_AIR * chargeK);
  // REAL air in the cylinder — set by the hardware, not by what the table claims.
  const veActual = veTrue == null ? veVal : veTrue;
  const airChargeG = (veActual / 100) * vCylM3 * airDensity * 1000;
  // What the ECU BELIEVES is in the cylinder, from the player's VE table.
  const airEstimateG = (veVal / 100) * vCylM3 * airDensity * 1000;
  const mafGps = (airChargeG * derived.cyl * (rpm / 2)) / 60;

  // --- MAF error / fuel trim. Open loop above ~85 kPa (near WOT).
  const netFactor = mafErrorBase * mafScalar;
  const openLoop = mapKpa >= 85;
  const effFactor = 1 + (netFactor - 1) * (openLoop ? 1 : 0.25);
  const trimPct = (effFactor - 1) * 100;

  // --- FUEL MASS from lambda and the fuel's own stoichiometric ratio.
  const lambdaCommanded = (afrCommanded / 14.7) / effFactor;
  // The ECU fuels for its ESTIMATE. If the estimate is wrong, so is the mixture.
  const fuelMassG = airEstimateG / (lambdaCommanded * fuel.stoich);

  // --- INJECTOR: the ECU computes pulse width for the injector size it has been
  // TOLD it has. Fit bigger injectors without rescaling and every pulse delivers
  // proportionally more fuel than intended — the classic "went rich after
  // upgrading injectors" mistake real tuners fix with a scaling constant.
  const ecuGramsPerMs = (ecuInjectorCc * fuel.density) / 60000;
  const actualGramsPerMs = (injectorCc * fuel.density) / 60000;
  const cycleTimeMs = 120000 / rpm;
  const pulseWidthMs = fuelMassG / ecuGramsPerMs + INJ_DEADTIME_MS;
  const maxPulseMs = cycleTimeMs * 0.9;
  const dutyPct = clamp((pulseWidthMs / cycleTimeMs) * 100, 0, 220);

  const cappedPw = Math.min(pulseWidthMs, maxPulseMs);
  const fuelLimited = pulseWidthMs > maxPulseMs;
  const deliveredFuelG = Math.max(1e-6, (cappedPw - INJ_DEADTIME_MS) * actualGramsPerMs);
  const lambdaActual = airChargeG / (deliveredFuelG * fuel.stoich);
  const actualAfr = lambdaActual * 14.7;

  // --- KNOCK ENVELOPE. MAP now drives the load term directly: low manifold
  // pressure means low cylinder pressure and lots of spare timing margin.
  const bestAfr = bestPowerAfr(boostPsi);
  const afrDelta = actualAfr - bestAfr;
  // Knock is driven by how much charge is actually TRAPPED in the cylinder, not by
  // manifold pressure alone. Two engines at the same MAP but different volumetric
  // efficiency see different peak pressures — which is exactly why a big-cam engine
  // that breathes better also needs a few degrees less timing than a stock one.
  const chargeIndex = (veVal / 100) * (mapKpa / BARO_KPA);
  // Knock margin is not linear in charge. Doubling the trapped mass roughly doubles
  // peak pressure, so margin scales with the RATIO of charge to the reference, not
  // the difference. At deep vacuum an engine effectively cannot knock at all — which
  // is why factory cruise maps carry 40-50 deg of advance and never complain.
  const loadBonus = chargeIndex >= COEFF.KNOCK_CHARGE_REF
    ? (COEFF.KNOCK_CHARGE_REF - chargeIndex) * COEFF.KNOCK_CHARGE_GAIN
    : (COEFF.KNOCK_CHARGE_REF / Math.max(chargeIndex, 0.04) - 1) * COEFF.KNOCK_CHARGE_RATIO_GAIN;
  const overBoost = Math.max(0, boostPsi - compressor.boostCeiling);
  const iatPenalty = Math.max(0, chargeC - 25) * COEFF.KNOCK_IAT_PER_C;
  const modsThresholdBonus = (mods.headers ? 1.5 : 0) + (mods.exhaust ? 0.5 : 0);
  let threshold = interp1(RPM, BASE_KNOCK_LIMIT_91, rpm) + octaneBonus + loadBonus + modsThresholdBonus
    + derived.configKnockBonus + derived.materialKnockBonus + derived.compressionKnockAdj
    - iatPenalty - overBoost * COEFF.KNOCK_OVERBOOST_PENALTY;
  // A lean mixture only threatens knock when there is real cylinder pressure behind
  // it. At light cruise (low MAP) an engine happily runs 14.7:1 with 40 deg of
  // advance and never knocks — which is exactly why factory cruise maps look like
  // that. Under boost the same leanness is dangerous. So scale the mixture terms
  // by charge pressure rather than applying them flat.
  const pressureFactor = clamp(Math.pow(mapKpa / BARO_KPA, 1.5), 0.05, 2.6);
  threshold -= Math.max(0, afrDelta) * COEFF.KNOCK_LEAN_PENALTY * pressureFactor;
  threshold += Math.min(COEFF.KNOCK_RICH_CAP, Math.max(0, -afrDelta) * COEFF.KNOCK_RICH_BONUS) * clamp(pressureFactor, 0.3, 1.5);

  const margin = threshold - timingVal;
  const knockPull = margin < 0 ? Math.min(COEFF.MAX_KNOCK_RETARD, -margin) : 0;
  const usedTiming = timingVal - knockPull;

  // --- COMBUSTION -> TORQUE
  const mbtIdeal = 24 + ((rpm - 1500) / 6000) * 12 - (mapKpa / BARO_KPA) * 6;
  const timingEff = Math.max(COEFF.EFFICIENCY_FLOOR, 1 - COEFF.TIMING_FALLOFF * Math.pow(usedTiming - mbtIdeal, 2));
  const afrEff = Math.max(COEFF.EFFICIENCY_FLOOR, 1 - COEFF.AFR_FALLOFF * Math.pow(actualAfr - bestAfr, 2));
  const burnedFuelG = Math.min(deliveredFuelG, airChargeG / fuel.stoich);
  const energyJ = (burnedFuelG / 1000) * fuel.lhv;

  // INDICATED work on the piston, expressed as a mean effective pressure.
  const indicatedJ = energyJ * derived.thermalEff * timingEff * afrEff;
  const imepPa = indicatedJ / vCylM3;

  // The engine must pay for its own rubbing friction and for pumping air past a
  // partly closed throttle before anything reaches the crank. Pumping loss is the
  // vacuum it is working against — which is precisely why part-throttle running is
  // inefficient and why a throttled engine brakes itself on overrun.
  const fmepPa = rubbingFmepPa(rpm, derived.springPa || 0) + pumpingFmepPa(mapKpa);
  const bmepPa = imepPa - fmepPa;

  // T = BMEP x Vd / (4*pi) for a four-stroke; power follows from torque.
  const torqueNmCrank = (bmepPa * (derived.displacementL / 1000)) / (4 * Math.PI);
  const powerW = torqueNmCrank * (2 * Math.PI * rpm / 60);
  const hp = (powerW / 745.7) * DRIVETRAIN_EFF;
  const torque = torqueNmCrank * 0.7376 * DRIVETRAIN_EFF;
  const bsfc = powerW > 0 ? (burnedFuelG * derived.cyl * (rpm / 2) * 60 / 453.6) / (powerW / 745.7) : 0;

  const egtProxy = knockPull * 22 + Math.max(0, actualAfr - bestAfr) * 45 + boostPsi * 6;
  const leanRisk = actualAfr > COEFF.LEAN_DAMAGE_AFR && mapKpa >= 85;
  // Excessively rich is its own failure mode, not just "safe". Unburnt fuel washes
  // the oil film off the bores, fouls plugs, dumps raw fuel into the catalyst and
  // costs real power — a genuinely damaging condition, just a slower one than knock.
  const richRisk = lambdaActual < COEFF.RICH_DAMAGE_LAMBDA && mapKpa >= 55;
  const valveRisk = leanRisk && boostPsi > 3;
  const mafFlag = Math.abs(trimPct) > 8 && (mods.intake || mods.turboFitted);
  const injMismatch = Math.abs(injectorCc / ecuInjectorCc - 1) > 0.05;

  return {
    rpm, hp: Math.round(hp), torque: Math.round(torque),
    ve: Number(veVal.toFixed(1)),
    afr: Number(actualAfr.toFixed(2)), afrCommanded: Number(afrCommanded.toFixed(2)),
    lambda: Number(lambdaActual.toFixed(3)),
    timing: Number(usedTiming.toFixed(1)), commandedTiming: Number(timingVal.toFixed(1)),
    duty: Math.round(dutyPct), pw: Number(pulseWidthMs.toFixed(2)),
    maf: Number(mafGps.toFixed(1)), map: Number(mapKpa.toFixed(0)),
    iat: Number(chargeC.toFixed(0)), airCharge: Number(airChargeG.toFixed(3)),
    boostPsi: Number(boostPsi.toFixed(1)), trimPct: Number(trimPct.toFixed(1)),
    threshold: Number(threshold.toFixed(1)), margin: Number(margin.toFixed(1)),
    chargeIndex: Number(chargeIndex.toFixed(3)),
    veTable: Number(veVal.toFixed(1)), veActual: Number(veActual.toFixed(1)),
    mbtIdeal: Number(mbtIdeal.toFixed(1)), timingEff, afrEff, openLoop,
    egt: Math.round(720 + egtProxy),
    imep: Number((imepPa / 100000).toFixed(2)), bmep: Number((bmepPa / 100000).toFixed(2)),
    fmep: Number((fmepPa / 100000).toFixed(2)), bsfc: Number(bsfc.toFixed(3)),
    bestAfr: Number(bestAfr.toFixed(2)),
    knock: knockPull > 0, knockPull, fuelLimited, leanRisk, richRisk, valveRisk, mafFlag, compressorOver, injMismatch,
  };
}

function simulateSweep({ loadKpa, ve, veTrueTable, timing, afr, turboOn, boostCurve, octaneBonus, octaneLabel,
                        fuel, injectorCc, ecuInjectorCc, injectorLabel, mods, mafScalar, derived,
                        turbine, compressor, exhaustDiaError }) {
  let mafErrorBase = 1.0;
  if (mods.intake) mafErrorBase *= 0.90;
  if (turboOn) mafErrorBase *= 0.92;
  const needsMafRecal = mods.intake || turboOn;
  const modsWithTurbo = { ...mods, turboFitted: turboOn };

  const points = [];
  for (let rpm = 1500; rpm <= 7500; rpm += 100) {
    const boostTarget = turboOn ? interp1(RPM, boostCurve, rpm) : 0;
    const man = computeManifold(rpm, loadKpa, turboOn, boostTarget, turbine, compressor);
    // Tables are indexed by ACTUAL manifold pressure, so adding boost walks the
    // calibration up into the high-MAP rows automatically.
    const veVal = interp2(ve, rpm, man.mapKpa);
    const veTrue = veTrueTable ? interp2(veTrueTable, rpm, man.mapKpa) : veVal;
    const timingVal = interp2(timing, rpm, man.mapKpa);
    const afrCommanded = interp2(afr, rpm, man.mapKpa);
    points.push(evaluatePoint({
      rpm, mapKpa: man.mapKpa, boostPsi: man.boostPsi, throttleFrac: man.throttleFrac,
      veVal, veTrue, timingVal, afrCommanded, octaneBonus, fuel, mods: modsWithTurbo,
      mafScalar, mafErrorBase, injectorCc, ecuInjectorCc, derived, compressor,
    }));
  }

  let pistonWear = 0, valveWear = 0;
  points.forEach((p) => {
    if (p.knock) pistonWear += p.knockPull * COEFF.WEAR_KNOCK;
    if (p.leanRisk) { if (p.valveRisk) valveWear += COEFF.WEAR_VALVE_LEAN_BOOST; else pistonWear += COEFF.WEAR_LEAN; }
    // Bore wash: unburnt fuel stripping the cylinder film is a ring/bore wear mode.
    if (p.richRisk) pistonWear += (COEFF.RICH_DAMAGE_LAMBDA - p.lambda) * COEFF.WEAR_RICH_BORE_WASH;
  });
  const avgBoost = points.reduce((s, p) => s + p.boostPsi, 0) / points.length;
  const bearingWear = (turboOn ? avgBoost * COEFF.WEAR_BEARING_PER_PSI : (loadKpa >= 100 ? 0.15 : 0.05)) * derived.bearingWearMult;
  const wear = { piston: pistonWear, bearing: bearingWear, valve: valveWear };

  const events = [];
  const rangeLabel = (run) => (run[0].rpm === run[run.length - 1].rpm ? `${run[0].rpm} RPM` : `${run[0].rpm}–${run[run.length - 1].rpm} RPM`);
  const rangeFrac = (run) => run.length / points.length; // how much of the full sweep this run covers

  groupRuns(points, (p) => p.knock).forEach((run) => {
    const peak = run.reduce((a, b) => (b.knockPull > a.knockPull ? b : a));
    const avgPull = run.reduce((s, p) => s + p.knockPull, 0) / run.length;
    const boosted = run.some((p) => p.boostPsi >= 1);
    const leanContrib = Math.max(0, peak.afr - peak.bestAfr) * 2.5;
    const causes = [];
    if (boosted) causes.push(`boost (up to ${Math.max(...run.map((p) => p.boostPsi)).toFixed(1)} psi here) eating into your margin`);
    if (leanContrib >= 1.5) causes.push(`the mixture running leaner than the ${peak.bestAfr}:1 best-power target here (peak ${peak.afr.toFixed(1)}:1)${peak.fuelLimited ? ', partly from injectors maxing out' : ''}`);
    if (causes.length === 0) causes.push(`the commanded timing itself being too aggressive for ${octaneLabel} octane and this compression ratio at this load`);
    const suggestedTiming = Math.max(-5, Math.round((peak.threshold - 1) * 2) / 2);
    const impact = Math.max(5, Math.round((10 + avgPull * 7) * (0.3 + 0.7 * rangeFrac(run))));
    events.push({
      type: 'knock', severity: 3, impact,
      msg: `Knock across ${rangeLabel(run)} — ECU pulled up to ${peak.knockPull.toFixed(1)}° (peak near ${peak.rpm} RPM)`,
      cause: `Caused by ${causes.join(' and ')}. This spans ${Math.round(rangeFrac(run) * 100)}% of the RPM sweep${avgPull >= 2 ? `, averaging ${avgPull.toFixed(1)}° of retard — tuners treat anything sustained above about 2° as a prelude to expensive engine damage, not an acceptable operating point` : ''}.`,
      fix: `On TIMING, pull the cells around ${peak.rpm} RPM / ${Math.round(loadKpa)} kPa toward ${suggestedTiming}° or less.${boosted ? ' Or back off boost in that range on BUILD.' : ''}${leanContrib >= 1.5 ? ` Or richen AFR toward ${peak.bestAfr}:1 there.` : ''} Higher octane, lower compression, or an aluminum head on BUILD also buy margin.`,
    });
  });
  groupRuns(points, (p) => p.fuelLimited).forEach((run) => {
    const peak = run.reduce((a, b) => (b.duty > a.duty ? b : a));
    const impact = Math.max(4, Math.round(10 * (0.3 + 0.7 * rangeFrac(run))));
    events.push({
      type: 'fuel', severity: 2, impact,
      msg: `Injectors maxed across ${rangeLabel(run)} (up to ${peak.duty}% duty) — mixture leaned to ${peak.afr.toFixed(1)}:1`,
      cause: `Required pulse width (${peak.pw} ms) exceeds 90% of the ${(120000 / peak.rpm).toFixed(1)} ms available per engine cycle at ${peak.rpm} RPM, so the ${injectorLabel} injectors physically cannot deliver the commanded fuel.${fuel.stoich < 12 ? ` ${octaneLabel} needs roughly ${(14.7 / fuel.stoich).toFixed(2)}× the fuel volume of gasoline at the same lambda — a big part of why you ran out here.` : ''}`,
      fix: `On FUEL, step up to a larger injector, or lower VE/boost in this range so demand fits under the current injectors' capacity.${fuel.stoich < 12 ? ' Switching back to a gasoline blend would also cut fuel volume sharply — at the cost of knock margin.' : ''}`,
    });
  });
  groupRuns(points, (p) => p.leanRisk && !p.valveRisk).forEach((run) => {
    const peak = run.reduce((a, b) => (b.afr > a.afr ? b : a));
    const impact = Math.max(4, Math.round(10 * (0.3 + 0.7 * rangeFrac(run))));
    events.push({
      type: 'lean', severity: 2, impact,
      msg: `Lean mixture (up to ${peak.afr.toFixed(1)}:1) across ${rangeLabel(run)} under load`,
      cause: peak.fuelLimited ? `This is the injector-duty limit above showing up as heat risk, not a bad AFR table entry.` : `The AFR target itself is set leaner than is safe for ${Math.round(loadKpa)} kPa in this range.`,
      fix: peak.fuelLimited ? `Upgrade injectors on FUEL, or lower VE/boost so demand fits within current capacity.` : `On AFR, richen the cells in this range — best power here is near ${peak.bestAfr}:1${peak.boostPsi > 1 ? ' (richer than the N/A ideal, because boost needs the charge cooling)' : ''}.`,
    });
  });
  groupRuns(points, (p) => p.valveRisk).forEach((run) => {
    const peak = run.reduce((a, b) => (b.afr > a.afr ? b : a));
    const overage = Math.min(1, Math.max(0, peak.afr - 15.2) / 6);
    const impact = Math.max(6, Math.round(18 * (0.25 + 0.75 * rangeFrac(run)) * (0.4 + 0.6 * overage)));
    events.push({
      type: 'valve', severity: 3, impact,
      msg: `Lean-under-boost across ${rangeLabel(run)} (up to ${peak.afr.toFixed(1)}:1 at ${peak.boostPsi.toFixed(1)} psi) — elevated EGT, valve risk`,
      cause: `Boost raises cylinder pressure and heat at the same time the mixture goes lean — that combination burns exhaust valves over repeated pulls, separately from detonation. This spans ${Math.round(rangeFrac(run) * 100)}% of the sweep.`,
      fix: `Richen AFR under boost in this range, confirm injectors are not maxed (FUEL tab), or add an intercooler.`,
    });
  });
  groupRuns(points, (p) => p.richRisk).forEach((run) => {
    const peak = run.reduce((a, b) => (b.lambda < a.lambda ? b : a));
    const sev = clamp((0.75 - peak.lambda) / 0.35, 0, 1);
    const impact = Math.max(6, Math.round((12 + sev * 26) * (0.35 + 0.65 * rangeFrac(run))));
    events.push({
      type: 'rich', severity: 3, impact,
      msg: `Dangerously rich across ${rangeLabel(run)} — down to lambda ${peak.lambda.toFixed(2)} (${peak.afr.toFixed(1)}:1)`,
      cause: `Far more fuel is being delivered than the available air can burn. Raw fuel washes the oil film off the cylinder walls, fouls plugs, and passes into the exhaust. It also costs a lot of power — the mixture is well past the point where extra fuel helps.`,
      fix: `Check the ECU Injector Size on FUEL matches the injectors actually fitted, verify the MAF scalar, then lean the AFR cells in this range back toward ${peak.bestAfr}:1.`,
    });
  });
  groupRuns(points, (p) => p.mafFlag).forEach((run) => {
    const avgTrim = run.reduce((s, p) => s + p.trimPct, 0) / run.length;
    const direction = avgTrim > 0 ? 'lean' : 'rich';
    const source = mods.intake && turboOn ? 'the bigger intake and turbo plumbing' : mods.intake ? 'the bigger intake' : 'the turbo plumbing';
    const impact = Math.round(8 * (0.3 + 0.7 * rangeFrac(run)));
    events.push({
      type: 'maf', severity: 1, impact,
      msg: `MAF trim averaging ${avgTrim > 0 ? '+' : ''}${avgTrim.toFixed(0)}% across ${rangeLabel(run)} — running ${direction}`,
      cause: `${source.charAt(0).toUpperCase() + source.slice(1)} changed how much air reads across the MAF sensor at a given flow rate, and the ECU has not been rescaled for it.`,
      fix: `On ECU, adjust the MAF Scalar and re-run the pull — watch the AFR trace (actual vs. commanded) until they line up.`,
    });
  });
  groupRuns(points, (p) => p.compressorOver).forEach((run) => {
    const peak = run.reduce((a, b) => (b.boostPsi > a.boostPsi ? b : a));
    const impact = Math.round(10 * (0.3 + 0.7 * rangeFrac(run)));
    events.push({
      type: 'compressor', severity: 2, impact,
      msg: `Compressor pushed past its efficient range across ${rangeLabel(run)} (target up to ${peak.boostPsi.toFixed(1)} psi)`,
      cause: `This compressor's practical ceiling is lower than the boost you're asking for here — beyond it, the compressor is working outside its efficient map, making hotter, less dense, more knock-prone air.`,
      fix: `On BUILD, size up the compressor, or lower the boost target for this RPM range.`,
    });
  });
  const injRatio = injectorCc / ecuInjectorCc;
  if (Math.abs(injRatio - 1) > 0.05) {
    const richLean = injRatio > 1 ? 'rich' : 'lean';
    events.push({
      type: 'injscale', severity: 3, impact: Math.round(clamp(14 + Math.abs(injRatio - 1) * 22, 14, 40)),
      msg: `Injector scaling mismatch — ECU is calibrated for ${ecuInjectorCc}cc but ${injectorCc}cc are fitted`,
      cause: `The ECU calculates pulse width for a ${ecuInjectorCc}cc injector. With ${injectorCc}cc actually fitted, every pulse delivers about ${(injRatio * 100).toFixed(0)}% of the intended fuel, so the whole tune runs ${richLean} no matter what your AFR table asks for.`,
      fix: `On FUEL, set the ECU Injector Size to ${injectorCc}cc to match the hardware. Real tuning software calls this the injector scaling constant (UpRev's K-fuel multiplier, HP Tuners' injector flow rate) — it must always be updated when injectors change.`,
    });
  }
  // A big cam's real cost is rarely peak-power knock — it is everything below the
  // power band: reversion, lost vacuum, lumpy idle, and a much narrower usable range.
  // This is a HARDWARE trade-off, not a calibration fault, so it is flagged as an
  // advisory rather than something the player can tune away.
  // Valve float is a hard mechanical limit — the springs cannot close the valves fast
  // enough, so cylinder filling collapses. No calibration change touches this.
  const floatRpm = derived.floatRpm || 99999;
  if (floatRpm < 7500) {
    const lost = points.filter((p) => p.rpm > floatRpm);
    events.push({
      type: 'float', severity: 3, impact: Math.round(clamp((7500 - floatRpm) / 45, 8, 34)),
      msg: `Valve float above ${Math.round(floatRpm)} RPM — cylinder filling collapsing over the last ${lost.length * 100} RPM of the pull`,
      cause: `The camshaft opens the valves but only the springs close them. Above ${Math.round(floatRpm)} RPM the valves stop following the lobe, so the cylinder cannot fill and power falls off a cliff instead of tapering. A ${derived.camDuration}° cam opens further and faster, which is exactly why it demands stiffer springs than stock.`,
      fix: `Raise the valve spring rate on BUILD until float sits above your ${7500} RPM redline, or fit a milder cam. No amount of table tuning can fix this — the valvetrain is simply not keeping up.`,
    });
  }

  const overlap = derived.overlapDeg || 0;
  if (overlap > 10) {
    const lowTq = points.find((p) => p.rpm === 2500)?.torque ?? 0;
    const peakTqPt = points.reduce((a, b) => (b.torque > a.torque ? b : a));
    events.push({
      type: 'cam', severity: 1, impact: Math.round(clamp(overlap * 0.35, 4, 14)),
      msg: `Large camshaft (${derived.camDuration}°, ${overlap.toFixed(0)}° overlap) — powerband moved up, low end given away`,
      cause: `At ${overlap.toFixed(0)}° of overlap both valves are open together long enough that at low RPM exhaust pushes back into the intake (reversion) and fresh charge escapes out the exhaust. Torque at 2500 RPM is down to ${lowTq} lb-ft while peak torque has moved to ${peakTqPt.rpm} RPM. Expect a lumpy idle, weak manifold vacuum and poorer driveability off boost.`,
      fix: `This is a hardware trade-off, not a tuning fault — you cannot calibrate it away. If the low end matters, fit a milder cam. If you want this cam, make sure the valve springs suit it (float at ${Math.round(derived.floatRpm)} RPM) and expect to gear the car for the higher powerband.`,
    });
  }
  if (turboOn && avgBoost > 6) {
    const impact = Math.round(6 * Math.min(1.5, avgBoost / 10));
    events.push({
      type: 'bearing', severity: 1, impact,
      msg: `Sustained boost load through the pull (avg ${avgBoost.toFixed(1)} psi) — bottom-end stress accumulating`,
      cause: `Cylinder pressure under boost stresses rod and main bearings even without knock.`,
      fix: `Keep boost near 8-10 psi unless the block has been built for more, and do not hold WOT pulls longer than needed.`,
    });
  }
  events.sort((a, b) => (b.impact ?? b.severity) - (a.impact ?? a.severity));

  const peakHp = Math.max(...points.map((p) => p.hp));
  const peakTq = Math.max(...points.map((p) => p.torque));
  return { points, events, wear, peakHp, peakTq, loadKpa, needsMafRecal };
}

// ============================================================
// LIVE ENGINE — a continuously running rotational-dynamics model.
// Unlike the dyno sweep (which evaluates steady-state points), this
// integrates real crankshaft physics in time: the engine accelerates
// because combustion torque exceeds friction torque, idles because
// the ECU trims air to hold a target, and stalls if it does not.
// ============================================================
const ENGINE_INERTIA = 0.18;   // kg·m², crank + flywheel + damper
const IDLE_TARGET_RPM = 800;
const CRANK_RPM = 260;         // starter cranking speed
const STALL_RPM = 380;
const REDLINE_CUT = 7600;      // fuel cut, as a real rev limiter does

// 2D interpolation across both RPM and load — real ECUs interpolate
// between table breakpoints rather than snapping to the nearest cell.
function interp2(table, rpm, loadPct) {
  const rowVals = LOAD.map((_, ri) => interp1(RPM, table[ri], rpm));
  const loadsAsc = [...LOAD].reverse();
  const valsAsc = [...rowVals].reverse();
  return interp1(loadsAsc, valsAsc, loadPct);
}

// Friction + pumping losses, expressed as FMEP. Rises with engine speed,
// and is what the engine must overcome before any torque reaches the wheels.
// Engine braking has two separate sources, and modelling only one made coast-down
// far too slow. RUBBING friction rises with speed. PUMPING loss is the work the
// engine does dragging air past a closed throttle — proportional to the vacuum it
// is pulling (barometric minus MAP). On a closed throttle at high RPM the pumping
// term dominates, which is exactly why a real engine drops revs so briskly.
// Torque from a mean effective pressure: T = MEP x Vd / (4*pi) for a 4-stroke.
// Rubbing (mechanical) friction as a mean effective pressure. Rises with engine
// speed, and with valve spring load if stiffer springs are fitted.
function rubbingFmepPa(rpm, springPa = 0) {
  const rpmShare = (1 - COEFF.SPRING_RPM_BIAS) + COEFF.SPRING_RPM_BIAS * (rpm / 7500);
  return COEFF.RUBBING_BASE_PA + rpm * COEFF.RUBBING_PER_RPM + springPa * rpmShare;
}

// Pumping loss: the work spent dragging air past a partly closed throttle. This is
// the vacuum the engine is fighting, and it dominates engine braking on overrun.
function pumpingFmepPa(mapKpa) {
  return Math.max(0, (BARO_KPA - mapKpa) * 1000);
}

// Total parasitic torque, for the live engine's cranking drag.
// T = MEP x Vd / (4*pi) for a four-stroke.
function frictionTorqueNm(rpm, displacementL, mapKpa = BARO_KPA, springPa = 0) {
  const fmep = rubbingFmepPa(rpm, springPa) + pumpingFmepPa(mapKpa);
  return (fmep * (displacementL / 1000)) / (4 * Math.PI);
}

// A simulated sensor: real ones are noisy and lag behind the true value.
function sensorRead(prev, trueVal, lagFactor, noiseAmp) {
  const lagged = prev + (trueVal - prev) * lagFactor;
  return lagged + (Math.random() - 0.5) * 2 * noiseAmp;
}

function makeLiveState() {
  return {
    running: false, cranking: false, rpm: 0, omega: 0,
    idleTrim: 5, stft: 0, ltft: 0,
    coolantC: 20, oilC: 20, knockCount: 0, fuelCut: false, dfco: false, limiterCut: false,
    sensedRpm: 0, sensedMaf: 0, sensedMap: 101, sensedIat: 25,
    sensedLambda: 1.0, sensedCoolant: 20, elapsed: 0,
  };
}

// One integration step of the live engine + one pass of the ECU control loop.
function liveStep(st, dt, input, cfg) {
  const s = { ...st };
  const { ve, timing, afr, derived, fuel, injectorCc, ecuInjectorCc, mods, mafScalar, mafErrorBase,
          turboOn, boostCurve, octaneBonus, turbine, compressor, exhaustDiaError } = cfg;

  s.prevRpm = st.rpm;
  s.elapsed += dt;

  // ---- starter / stall handling ----
  if (s.cranking && s.rpm > 450) { s.cranking = false; s.running = true; }
  if (s.running && s.rpm < STALL_RPM) { s.running = false; s.fuelCut = false; }

  // ---- ECU idle air control (PI holding target idle) ----
  const userThrottle = input.throttle;
  if (s.running && userThrottle < 3) {
    if (s.rpm < 2000) {
      // Near idle: closed-loop control. Air is added far faster than it is
      // removed (a dashpot), so the engine catches itself instead of stalling.
      const err = IDLE_TARGET_RPM - s.rpm;
      const gain = err > 0 ? COEFF.IDLE_AIR_GAIN_UP : COEFF.IDLE_AIR_GAIN_DOWN;
      const damp = (s.rpm - (s.prevRpm ?? s.rpm)) * COEFF.IDLE_AIR_DAMP;
      s.idleTrim = clamp(s.idleTrim + err * gain * (dt / 0.05) - damp, 1, 34);
    } else {
      // Coasting down off-idle: bleed the idle valve back toward its base
      // position so the engine can actually decelerate.
      s.idleTrim += (3 - s.idleTrim) * COEFF.IDLE_BLEED_RATE * (dt / 0.05);
    }
  }
  const coldEnrich = s.coolantC < 80 ? 1 + (80 - s.coolantC) * 0.004 : 1;
  const effThrottle = clamp(Math.max(userThrottle, s.running ? s.idleTrim : 0), 0, 100);

  // ---- rev limiter + deceleration fuel cut-off (DFCO) ----
  // Real ECUs shut the injectors off completely on a closed throttle above idle:
  // the engine is being driven by its own inertia, so burning fuel there is pure
  // waste. It is also why a real engine drops back to idle briskly instead of
  // hanging. Fuel is restored with hysteresis before the engine can stall.
  const overrun = s.running && userThrottle < 3 && s.rpm > (s.dfco ? 1600 : 1850) && s.coolantC > 45;
  s.dfco = overrun;
  // A real rev limiter is a hysteresis loop, not a ceiling: fuel is cut at the
  // limit, revs fall, fuel is restored a few hundred RPM lower, and the engine
  // climbs back into the cut. That rapid cut-restore cycle IS the bounce you hear.
  if (s.running) {
    if (s.rpm >= REDLINE_CUT) s.limiterCut = true;
    else if (s.rpm < REDLINE_CUT - 320) s.limiterCut = false;
  } else s.limiterCut = false;
  s.fuelCut = (s.running && s.limiterCut) || overrun;

  // ---- combustion torque from the same physics the dyno uses ----
  let crankNm = 0, pt = null;
  if ((s.running || s.cranking) && s.rpm > 100) {
    const rpmClamped = clamp(s.rpm, 700, 7500);
    // Throttle opening sets manifold pressure — but so does ENGINE SPEED. A nearly
    // closed throttle at high RPM pulls far harder vacuum than the same opening at
    // idle, because the engine is trying to pump much more air through the same
    // restriction. That rpm term is what lets the engine decelerate on a closed
    // throttle instead of sustaining itself at redline.
    const aFrac = clamp(effThrottle, 0, 100) / 100;
    const nFrac = clamp(rpmClamped / 7500, 0, 1.2);
    // Valve overlap lets exhaust back into the intake at low speed, so a big cam
    // simply cannot pull strong manifold vacuum at idle. That lost vacuum is why
    // cammed engines idle high and lumpy.
    const overlapBleed = (derived.overlapDeg || 0) * 0.0042;
    const loadKpa = BARO_KPA * clamp(
      0.18 + overlapBleed + 0.82 * Math.pow(aFrac, 0.75) - 0.28 * nFrac * Math.pow(1 - aFrac, 2),
      0.12, 1
    );
    const boostTarget = turboOn ? interp1(RPM, boostCurve, rpmClamped) : 0;
    const man = computeManifold(rpmClamped, loadKpa, turboOn, boostTarget, turbine, compressor);
    const veVal = interp2(ve, rpmClamped, man.mapKpa);
    const veTrue = cfg.veTrueTable ? interp2(cfg.veTrueTable, rpmClamped, man.mapKpa) : veVal;
    // Spark-based idle stabilisation: the air path is slow (throttle -> manifold
    // -> cylinder takes several cycles), so real ECUs hold idle with IGNITION
    // timing, which changes torque on the very next firing event. Air trim handles
    // the slow drift; spark handles the fast corrections.
    let idleSpark = 0;
    if (s.running && userThrottle < 3 && s.rpm < 1600) {
      idleSpark = clamp((IDLE_TARGET_RPM - s.rpm) * COEFF.IDLE_SPARK_GAIN, -COEFF.IDLE_SPARK_LIMIT, COEFF.IDLE_SPARK_LIMIT);
    }
    const timingVal = interp2(timing, rpmClamped, man.mapKpa) + idleSpark;
    const afrCmd = interp2(afr, rpmClamped, man.mapKpa) / coldEnrich;
    pt = evaluatePoint({
      rpm: rpmClamped, mapKpa: man.mapKpa, boostPsi: man.boostPsi, throttleFrac: man.throttleFrac,
      veVal, veTrue, timingVal, afrCommanded: afrCmd, octaneBonus, fuel,
      mods: { ...mods, turboFitted: turboOn },
      mafScalar: mafScalar * (1 + s.ltft / 100 + s.stft / 100),
      mafErrorBase, injectorCc, ecuInjectorCc, derived, compressor,
    });
    // evaluatePoint already returns BRAKE torque — friction and pumping are
    // subtracted inside it — so we must not deduct them again here.
    if (!s.fuelCut && !s.cranking) {
      crankNm = pt.torque / 0.7376 / DRIVETRAIN_EFF;
    } else if (!s.cranking) {
      // Fuel cut: no combustion at all, so the engine is being motored against its
      // own friction and pumping losses. That is engine braking, for real.
      crankNm = -(pt.fmep * 100000 * (derived.displacementL / 1000)) / (4 * Math.PI);
    }
    if (pt.knock) s.knockCount += pt.knockPull * dt * 8;
  }

  // ---- rotational dynamics ----
  const starterNm = s.cranking ? 180 : 0;
  // Cranking has no combustion, so the starter works against motoring friction.
  const crankingDrag = s.cranking ? frictionTorqueNm(Math.max(s.rpm, 0), derived.displacementL, pt ? pt.map : BARO_KPA) : 0;
  const netNm = crankNm + starterNm - crankingDrag - (s.running ? input.load : 0);
  const alpha = netNm / ENGINE_INERTIA;
  s.omega = Math.max(0, s.omega + alpha * dt);
  s.rpm = s.omega * 60 / (2 * Math.PI);
  if (!s.running && !s.cranking) s.rpm = Math.max(0, s.rpm - 900 * dt);
  s.omega = s.rpm * 2 * Math.PI / 60;

  // ---- thermal model ----
  if (s.running) {
    const heatIn = 0.9 + (crankNm / 200) * 3.2;
    s.coolantC = Math.min(95, s.coolantC + heatIn * dt * (s.coolantC < 88 ? 1 : 0.15));
    s.oilC = Math.min(110, s.oilC + heatIn * dt * 0.7);
  } else {
    s.coolantC = Math.max(20, s.coolantC - 0.35 * dt);
    s.oilC = Math.max(20, s.oilC - 0.3 * dt);
  }

  // ---- ECU closed-loop fuel trims ----
  // Only at part throttle: at WOT the ECU goes open-loop and stops
  // correcting, which is exactly when MAF scaling errors bite.
  const closedLoop = s.running && pt && !pt.openLoop && s.coolantC > 45;
  if (closedLoop && pt) {
    const lambdaErr = pt.lambda - 1.0;
    s.stft = clamp(s.stft + lambdaErr * COEFF.STFT_GAIN * (dt / 0.05) * 0.25, -COEFF.TRIM_LIMIT, COEFF.TRIM_LIMIT);
    s.ltft = clamp(s.ltft + s.stft * COEFF.LTFT_LEARN_RATE * (dt / 0.05), -COEFF.TRIM_LIMIT, COEFF.TRIM_LIMIT);
  } else if (s.running) {
    s.stft += (0 - s.stft) * 0.06;
  }

  // ---- simulated sensors: lag + noise ----
  const lag = clamp(dt / 0.09, 0, 1);
  const lopeAmp = s.running && s.rpm < 1500 ? (derived.overlapDeg || 0) * 0.9 : 0;
  s.lope = lopeAmp;
  s.sensedRpm = sensorRead(s.sensedRpm, s.rpm, lag, 14 + lopeAmp);
  s.sensedMaf = sensorRead(s.sensedMaf, pt ? pt.maf : 0, lag * 0.8, 1.4);
  s.sensedMap = sensorRead(s.sensedMap, pt ? pt.map : BARO_KPA, lag, 0.7);
  s.sensedIat = sensorRead(s.sensedIat, pt ? pt.iat : 25, 0.05, 0.3);
  s.sensedLambda = sensorRead(s.sensedLambda, pt && s.running && !s.fuelCut ? pt.lambda : 1.6, lag * 0.5, 0.008);
  s.sensedCoolant = sensorRead(s.sensedCoolant, s.coolantC, 0.08, 0.25);
  s.live = pt;
  s.effThrottle = effThrottle;
  s.closedLoop = closedLoop;
  return s;
}

// ============================================================
// 13. DRIVETRAIN & DRAG STRIP
// ------------------------------------------------------------
// Longitudinal vehicle dynamics. The engine's torque curve is only half the story —
// what actually reaches the ground depends on gearing, tyre size, weight transfer
// and grip, and what the car does with it depends on mass and aerodynamic drag.
//
// Verified grip figures: street tyres measure 0.8-0.9 from braking distance, good
// road tyres reach ~1.0, and racing slicks are quoted at 1.7-1.9. Prepared drag
// surfaces with slicks go higher again.
// ============================================================
const QUARTER_MILE_M = 402.336;
const G = 9.80665;
const RHO_AIR = 1.185;        // kg/m3 at sea level, 25 C — same value the engine uses

const TIRE_GRIP = [
  { label: 'Street', mu: 0.85, note: 'All-season road tyre' },
  { label: 'Sport', mu: 1.05, note: 'Summer performance tyre' },
  { label: 'Race', mu: 1.75, note: 'Racing slick' },
  { label: 'Drag', mu: 2.40, note: 'Drag radial on a prepped surface' },
];

// Body styles. Mass, drag coefficient, frontal area, centre-of-gravity height,
// wheelbase and static rear weight fraction are all real levers — a van is slow
// not because of a penalty but because it is heavy, tall, boxy and nose-heavy.
const CAR_BODIES = [
  { label: 'Sports Coupe', massKg: 1610, cd: 0.30, frontalAreaM2: 2.00, cgHeightM: 0.50,
    wheelbaseM: 2.65, rearFrac: 0.47,
    note: 'Balanced, low and slippery. The reference car.' },
  { label: 'Supercar', massKg: 1450, cd: 0.32, frontalAreaM2: 1.90, cgHeightM: 0.42,
    wheelbaseM: 2.70, rearFrac: 0.57,
    note: 'Light, very low, and mid-engined so most of the weight already sits over the driven axle.' },
  { label: 'Sedan', massKg: 1560, cd: 0.29, frontalAreaM2: 2.20, cgHeightM: 0.56,
    wheelbaseM: 2.85, rearFrac: 0.45,
    note: 'Slippery but taller and nose-heavy. Long wheelbase resists weight transfer.' },
  { label: 'Van', massKg: 2100, cd: 0.36, frontalAreaM2: 3.20, cgHeightM: 0.78,
    wheelbaseM: 3.10, rearFrac: 0.42,
    note: 'Heavy, tall and a big flat face. High centre of gravity does help it hook up.' },
  { label: 'Truck', massKg: 2350, cd: 0.42, frontalAreaM2: 3.40, cgHeightM: 0.75,
    wheelbaseM: 3.55, rearFrac: 0.38,
    note: 'Heaviest and least aerodynamic, with little static weight over the rear axle.' },
];

const DRIVETRAIN_OPTS = [
  { label: 'RWD', driveFrac: null, transferGain: 1.0, note: 'Rear drive — launches on weight transfer' },
  { label: 'AWD', driveFrac: 1.00, transferGain: 0.0, note: 'All four wheels driven' },
];

const GEARBOX_OPTS = [
  { label: 'Manual', shiftSec: 0.35, launchMult: 1.0, note: 'You shift it; slower changes, no converter' },
  { label: 'Automatic', shiftSec: 0.15, launchMult: 1.9, note: 'Faster shifts, and the converter multiplies torque off the line' },
];

// A 350Z-sized car. Mass includes driver; Cd and frontal area are typical for the shape.
const DEFAULT_CAR = {
  bodyIdx: 0,
  rearFrac: 0.47,
  massKg: 1610,
  cd: 0.30,
  frontalAreaM2: 2.00,
  crr: 0.013,          // rolling resistance coefficient
  cgHeightM: 0.50,     // centre of gravity height — sets weight transfer
  wheelbaseM: 2.65,
  tireDiameterIn: 26,  // overall rolling diameter
  finalDrive: 3.54,
  gears: [3.79, 2.32, 1.62, 1.27, 1.00, 0.79],
  gearCount: 6,
  gripIdx: 0,
  driveIdx: 0,
  boxIdx: 0,
};

// Wheel torque available at a given road speed, in newton-metres.
function wheelTorqueAt(vMs, gearRatio, car, torqueCurveNm, redline) {
  const rM = (car.tireDiameterIn * 0.0254) / 2;
  // Road speed maps to engine speed through the gearing and tyre circumference.
  const rpm = (vMs / (2 * Math.PI * rM)) * gearRatio * car.finalDrive * 60;
  if (rpm > redline) return { rpm, torque: 0, overRev: true };
  const engNm = torqueCurveNm(Math.max(rpm, 1000));
  return { rpm, torque: engNm * gearRatio * car.finalDrive, overRev: false };
}

// Full quarter-mile run. Integrates Newton's second law with traction, aero drag,
// rolling resistance, gear changes and dynamic weight transfer.
function simulateDragRun({ car, torqueCurveNm, redline, peakHp }) {
  const grip = TIRE_GRIP[car.gripIdx];
  const drive = DRIVETRAIN_OPTS[car.driveIdx];
  const box = GEARBOX_OPTS[car.boxIdx];
  const gears = car.gears.slice(0, car.gearCount);
  const rM = (car.tireDiameterIn * 0.0254) / 2;

  // Rotating parts must be spun up as well as the car moved, so they behave like
  // extra mass. The effect is strongest in low gears, where the engine spins fastest
  // relative to road speed.
  const rotFactor = (g) => 1 + 0.045 * Math.pow(g / gears[0], 2) + 0.02;

  const dt = 0.005;
  // Engine speed is tracked SEPARATELY from road speed. They are only locked
  // together when the tyre is actually gripping — the moment it breaks loose the
  // engine is free to climb, which is why a car that is spinning bounces off the
  // limiter instead of following the speedometer.
  let engineRpm = box.launchMult > 1 ? 2200 : 2600;   // converter stall vs clutch launch
  let limiterCut = false;
  // DRIVER MODEL. A real driver does not hold the throttle flat while the tyre is
  // spinning — first gear runs to over 40 mph, so that would be a burnout halfway
  // down the strip. After a short reaction delay they feather it to keep the tyre
  // just at the limit, which is both what actually happens and what is fastest.
  let driverThrottle = 1;
  const REACTION_S = 0.45;
  let v = 0, x = 0, t = 0, gearIdx = 0, shiftUntil = -1;
  let sixty = null, sixtyFtT = null, eighthT = null, eighthV = null;
  const trace = [];
  let maxWheelspin = 0, launched = false;

  while (x < QUARTER_MILE_M && t < 40) {
    const gearRatio = gears[gearIdx];
    const shifting = t < shiftUntil;

    let tractive = 0, spinning = false;
    // What the engine WOULD be doing if the tyre were fully hooked up.
    const gearedRpm = (v / (2 * Math.PI * rM)) * gearRatio * car.finalDrive * 60;

    if (!shifting) {
      // Off the line the engine is not yet coupled to road speed: a manual slips the
      // clutch, an automatic multiplies torque through the converter.
      const launchBoost = box.launchMult > 1
        ? box.launchMult - (box.launchMult - 1) * clamp(v / 8, 0, 1)
        : 1;
      const engNm = limiterCut ? 0 : torqueCurveNm(clamp(engineRpm, 1000, redline));
      tractive = (engNm * gearRatio * car.finalDrive * launchBoost * driverThrottle) / rM;
    }

    // Weight transfer: accelerating shifts load rearward, which is why a rear-drive
    // car can put down more than its static rear weight fraction suggests.
    const aPrev = trace.length ? trace[trace.length - 1].a : 0;
    // Load transferred onto the driven axle under acceleration: dN = m*a*h/L.
    // (transferGain is applied once here — AWD already has all the weight, so it
    //  gains nothing from transfer.)
    const transfer = drive.transferGain * (car.massKg * aPrev * car.cgHeightM) / car.wheelbaseM;
    const driveFrac = drive.driveFrac ?? (car.rearFrac ?? 0.47);
    const normalN = Math.max(0, car.massKg * G * driveFrac + transfer);
    const gripLimitN = grip.mu * normalN;

    // Feather the throttle once the driver has reacted. Backing off is quick;
    // getting back into it is deliberately slower, so it settles rather than
    // oscillating — the same thing a driver does by feel.
    if (t > REACTION_S && tractive > gripLimitN) {
      driverThrottle = Math.max(0.30, driverThrottle - 3.2 * dt);
    } else if (tractive < gripLimitN * 0.94) {
      driverThrottle = Math.min(1, driverThrottle + 1.1 * dt);
    }

    if (tractive > gripLimitN) {
      spinning = true;
      // Past the limit the tyre slips and the effective coefficient falls away.
      tractive = gripLimitN * 0.92;
      maxWheelspin = Math.max(maxWheelspin, 1);
    }

    // --- Engine speed ---------------------------------------------------------
    if (shifting) {
      // Clutch is out / clutches releasing: revs fall on their own.
      engineRpm = Math.max(1200, engineRpm - 5200 * dt);
    } else if (spinning) {
      // Free to accelerate — the tyre is no longer holding the engine back. This is
      // what makes a spinning car sit on the limiter rather than tracking speed.
      // Rate of climb scales with how much throttle is actually being used.
      engineRpm += 7200 * dt * driverThrottle;
      if (!limiterCut && engineRpm >= redline) limiterCut = true;
      if (limiterCut) {
        engineRpm -= 15000 * dt;                       // fuel cut, revs drop fast
        if (engineRpm < redline - 350) limiterCut = false;   // fuel restored: the bounce
      }
      engineRpm = clamp(engineRpm, 1200, redline + 120);
    } else {
      // Hooked up: engine is tied to road speed through the gearing. Below the
      // launch speed the clutch or converter is still slipping, so it blends in
      // rather than snapping to the geared value.
      const launchRpm = box.launchMult > 1 ? 2200 : 3200;
      let target;
      if (box.launchMult > 1) {
        // AUTOMATIC. A converter has no engagement event — it simply slips until the
        // gearing catches up to its stall speed, so the engine genuinely does sit
        // near stall and then rise. That flat period is correct for an automatic.
        target = Math.max(gearedRpm, launchRpm * clamp(1 - v / 14, 0, 1) + gearedRpm * clamp(v / 14, 0, 1));
      } else {
        // MANUAL. The clutch is released over roughly a second, and as it takes up
        // the engine speed is pulled DOWN to meet the gearing — the revs drop as the
        // clutch bites. Holding launch RPM flat until a fixed road speed (as this
        // previously did) left it hanging at 2600 long after the clutch was out.
        const engage = clamp(t / 1.25, 0, 1);
        target = Math.max(gearedRpm, launchRpm * (1 - engage) + gearedRpm * engage);
      }
      engineRpm += (target - engineRpm) * Math.min(1, dt * 14);
      if (engineRpm >= redline) { limiterCut = true; }
      if (limiterCut) {
        engineRpm -= 15000 * dt;
        if (engineRpm < redline - 350) limiterCut = false;
      }
      engineRpm = clamp(engineRpm, 900, redline + 120);
    }
    const rpm = engineRpm;

    const dragN = 0.5 * RHO_AIR * car.cd * car.frontalAreaM2 * v * v;
    const rollN = car.crr * car.massKg * G;
    const netN = tractive - dragN - (v > 0.1 ? rollN : 0);
    const a = netN / (car.massKg * rotFactor(gearRatio));

    v = Math.max(0, v + a * dt);
    x += v * dt;
    t += dt;
    if (!launched && v > 0.5) launched = true;

    if (sixty === null && v >= 26.8224) sixty = t;                 // 60 mph in m/s
    // 60-FOOT TIME — the metric drag racers actually judge a launch by. It is the
    // first 60 feet (18.288 m) of the run, and it is dominated almost entirely by
    // traction and launch quality rather than power.
    if (sixtyFtT === null && x >= 18.288) sixtyFtT = t;
    if (eighthT === null && x >= QUARTER_MILE_M / 2) { eighthT = t; eighthV = v; }

    // Shift at redline.
    // The driver upshifts when the CAR has the speed for the next gear, not because
    // a spinning tyre has sent the tacho to the limiter. Shifting off wheelspin
    // would drop it into second at walking pace.
    if (!shifting && gearedRpm >= redline - 60 && gearIdx < gears.length - 1) {
      gearIdx++;
      shiftUntil = t + box.shiftSec;
      limiterCut = false;
    }
    if (trace.length === 0 || t - trace[trace.length - 1].t > 0.02) {
      trace.push({ t, x, v, rpm, gear: gearIdx + 1, a, spinning, limiter: limiterCut, throttle: driverThrottle });
    }
  }

  const trapMph = v * 2.23694;
  return {
    et: t, trapMph, zeroToSixty: sixty, sixtyFootT: sixtyFtT, eighthET: eighthT, eighthMph: eighthV ? eighthV * 2.23694 : 0,
    trace, wheelspun: maxWheelspin > 0, finished: x >= QUARTER_MILE_M,
    topGearUsed: gearIdx + 1, peakHp,
  };
}
// ============================================================
// 12. USER INTERFACE
// ------------------------------------------------------------
// Everything below is presentation. It reads the simulation's output but never
// contains physics — if you find yourself doing engineering maths down here, it
// belongs in the simulation section above instead.
//
// Layout: a design-token object (T), then small shared primitives, then the
// screens. Screens are plain conditional blocks inside one component; each is
// marked with a banner comment.
// ============================================================

// ============================================================
// DESIGN SYSTEM — a small, named token set applied everywhere
// below through shared primitives, instead of one-off inline
// styles per screen. This is what makes the UI read as one
// coherent product instead of a stack of separately-styled forms.
// ============================================================
const T = {
  bg: '#0a0d11', panel: '#12161c', panel2: '#181d24', panelHi: '#1e242c',
  line: '#242b34', lineHi: '#33404d',
  ink: '#eef2f5', ink2: '#8b96a3', ink3: '#57616c',
  amber: '#ff6a2c', amberInk: '#ffab7a', amberBg: '#2a1810',
  cyan: '#3ec8ff', cyanBg: '#0f2530',
  violet: '#b083ff', violetBg: '#211a30',
  green: '#39d980', greenBg: '#0f2418',
  yellow: '#ffc94d', yellowBg: '#2a2110',
  red: '#ff5252', redBg: '#2a1414',
  mono: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
  sans: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
};
const statusColor = (v) => (v >= 90 ? T.green : v >= 55 ? T.yellow : T.red);

const Eyebrow = ({ children, icon: Icon }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
    <div style={{ width: 3, height: 13, background: T.amber, borderRadius: 2 }} />
    {Icon && <Icon size={13} color={T.amberInk} />}
    <span style={{ fontSize: 10.5, letterSpacing: 1.6, color: T.amberInk, textTransform: 'uppercase', fontWeight: 800 }}>{children}</span>
  </div>
);

const Panel = ({ children, style, tight }) => (
  <div style={{ background: T.panel2, border: `1px solid ${T.line}`, borderRadius: 12, padding: tight ? '10px 12px' : 14, ...style }}>
    {children}
  </div>
);

const Note = ({ children, tone = 'info' }) => {
  const colors = { info: [T.ink2, T.line, T.panel2], warn: [T.yellow, '#3a2f16', T.yellowBg] };
  const [fg, bd, bgc] = colors[tone] || colors.info;
  return (
    <div style={{ display: 'flex', gap: 9, background: bgc, border: `1px solid ${bd}`, borderRadius: 10, padding: '11px 13px', margin: '10px 0', fontSize: 12.5, color: fg === T.ink2 ? '#b7c0c9' : fg, lineHeight: 1.55 }}>
      <Info size={15} style={{ flexShrink: 0, marginTop: 1, color: fg }} />
      <div>{children}</div>
    </div>
  );
};

function ExpandableInfo({ title, children }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ margin: '10px 0', border: `1px solid ${T.line}`, borderRadius: 10, overflow: 'hidden', background: T.panel }}>
      <button onClick={() => setOpen((o) => !o)} style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '11px 13px', background: 'none', border: 'none' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 9, color: T.ink, fontSize: 12.5, fontWeight: 700, textAlign: 'left' }}>
          <Info size={14} style={{ color: T.amber, flexShrink: 0 }} />{title}
        </span>
        <ChevronDown size={15} style={{ color: T.ink3, flexShrink: 0, marginLeft: 8, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .2s' }} />
      </button>
      <div style={{ maxHeight: open ? 900 : 0, opacity: open ? 1 : 0, overflow: 'hidden', transition: 'max-height .3s ease, opacity .2s ease' }}>
        <div style={{ padding: '0 13px 13px', fontSize: 12.5, color: '#a5aebb', lineHeight: 1.65 }}>{children}</div>
      </div>
    </div>
  );
}

// Segmented row of equal-width option buttons — replaces the repeated
// flex-row-of-buttons pattern used all over the tuning screens.
function Seg({ options, value, onChange, wrap }) {
  return (
    <div style={{ display: 'flex', gap: 7, marginBottom: 4, flexWrap: wrap ? 'wrap' : 'nowrap' }}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button key={o.value} onClick={() => onChange(o.value)} style={{
            flex: wrap ? '1 1 30%' : 1, padding: '11px 4px', borderRadius: 9, fontWeight: 700, fontSize: 12.5,
            border: `1px solid ${active ? T.amber : T.line}`, background: active ? T.amberBg : T.panel2,
            color: active ? T.amberInk : T.ink2, transition: 'all .15s',
          }}>{o.label}</button>
        );
      })}
    </div>
  );
}

// Full-width descriptive rows for choices that need a subtitle (turbine, injectors).
function PickList({ options, value, onChange }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 4 }}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button key={o.value} onClick={() => onChange(o.value)} style={{
            textAlign: 'left', padding: '11px 13px', borderRadius: 9, fontWeight: 600, fontSize: 13,
            border: `1px solid ${active ? T.amber : T.line}`, background: active ? T.amberBg : T.panel2,
            color: active ? T.amberInk : '#c3cad2',
          }}>{o.label}{o.sub && <div style={{ fontSize: 11, color: T.ink2, marginTop: 2, fontWeight: 400 }}>{o.sub}</div>}</button>
        );
      })}
    </div>
  );
}

function ToggleRow({ label, sub, checked, onChange, color = T.amber }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: T.panel2, border: `1px solid ${T.line}`, borderRadius: 10, padding: 13 }}>
      <div style={{ marginRight: 10 }}>
        <div style={{ fontWeight: 700, fontSize: 13.5, color: T.ink }}>{label}</div>
        {sub && <div style={{ fontSize: 11.5, color: T.ink2, marginTop: 1 }}>{sub}</div>}
      </div>
      <button onClick={() => onChange(!checked)} style={{ width: 48, height: 27, borderRadius: 14, border: 'none', position: 'relative', flexShrink: 0, background: checked ? color : '#2a323a', transition: 'background .2s' }}>
        <div style={{ position: 'absolute', top: 3, left: checked ? 24 : 3, width: 21, height: 21, borderRadius: 11, background: '#fff', transition: 'left .2s', boxShadow: '0 1px 3px rgba(0,0,0,.4)' }} />
      </button>
    </div>
  );
}

function StatTile({ label, value, unit, color = T.ink, flex = 1 }) {
  return (
    <div style={{ flex, background: T.panel2, border: `1px solid ${T.line}`, borderRadius: 11, padding: 13 }}>
      <div style={{ fontSize: 9.5, color: T.ink2, letterSpacing: 1, fontWeight: 700 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 800, fontFamily: T.mono, color, marginTop: 2 }}>{value}<span style={{ fontSize: 11.5, color: T.ink2, marginLeft: 3, fontWeight: 600 }}>{unit}</span></div>
    </div>
  );
}

function HealthBar({ label, value }) {
  const c = statusColor(value);
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10.5, color: T.ink2, marginBottom: 4, fontWeight: 600 }}>
        <span>{label}</span><span style={{ color: c, fontWeight: 800 }}>{Math.round(value)}%</span>
      </div>
      <div style={{ height: 7, background: T.panel, borderRadius: 4, overflow: 'hidden', border: `1px solid ${T.line}` }}>
        <div style={{ width: `${value}%`, height: '100%', background: c, borderRadius: 4, transition: 'width .4s', boxShadow: `0 0 8px ${c}66` }} />
      </div>
    </div>
  );
}

// Guided first run. Walks a new player through the actual working order a tuner
// uses — build the engine, calibrate it, hear it run, then measure it — and then
// gets out of the way. Purely navigational: it never changes the simulation.
const JOURNEY = [
  { tab: 'build', title: 'Step 1 · Build the engine',
    body: 'Open Engine Architecture and design a short block: bore, stroke, compression, cam, springs. Then fit parts under Bolt-Ons. Nothing here is cosmetic — every choice changes how the engine breathes.',
    cta: 'Done building — go tune it', next: 'tune' },
  { tab: 'tune', title: 'Step 2 · Calibrate it',
    body: 'AIR is your airflow log — if it is stale after your build, accept the re-logged values. Then SPARK sets ignition timing and FUEL sets the mixture. The advisories tell you what your hardware will tolerate; the editing is yours.',
    cta: 'Calibration set — start the engine', next: 'dash' },
  { tab: 'live', title: 'Step 3 · Start it and listen',
    body: 'Press START. Watch it idle, hold the throttle to rev it, and watch the sensors and fuel trims respond in real time. This is your calibration actually running.',
    cta: 'Sounds good — put it on the dyno', next: 'dyno' },
  { tab: 'dyno', title: 'Step 4 · Measure it',
    body: 'Run a pull. Then read the Pull Log before you look at the power number — it explains anything that went wrong and what to change. From here the loop is: adjust, pull again, compare.',
    cta: 'Finish — let me explore freely', next: null },
];

// Sports coupe side profile. Drawn from a clean baseline: wheels on the ground at
// a fixed centre height, body built above them, roof peak set back behind the
// midpoint for a cab-rearward stance.
// Body outlines. Each is drawn to the same 420x168 box with wheels on a common
// ground line, so they can be swapped without the strip layout shifting.
const BODY_PATHS = [
  // Sports coupe — low nose, cab rearward, fastback
  { body: 'M 22 104 L 44 92 L 92 84 L 132 82 L 168 52 L 246 46 L 300 62 L 352 76 L 388 88 L 400 100 L 400 116 L 22 116 Z',
    glass: 'M 176 56 L 244 51 L 292 65 L 300 78 L 150 80 Z', wheels: [112, 316], wr: 30 },
  // Supercar — very low, long tail, cab far forward
  { body: 'M 16 106 L 40 96 L 96 88 L 140 60 L 214 52 L 268 58 L 340 70 L 396 84 L 406 102 L 406 116 L 16 116 Z',
    glass: 'M 150 62 L 212 56 L 258 62 L 268 78 L 132 80 Z', wheels: [104, 320], wr: 30 },
  // Sedan — three-box, taller greenhouse, longer roof
  { body: 'M 20 100 L 44 88 L 96 82 L 128 54 L 258 50 L 300 76 L 372 82 L 400 94 L 402 116 L 20 116 Z',
    glass: 'M 136 58 L 254 54 L 288 76 L 126 78 Z', wheels: [106, 322], wr: 29 },
  // Van — tall box, flat face, short nose
  { body: 'M 24 108 L 30 60 L 60 36 L 300 32 L 384 44 L 402 74 L 404 116 L 24 116 Z',
    glass: 'M 46 62 L 66 42 L 172 40 L 172 62 Z M 186 40 L 292 38 L 300 62 L 186 62 Z', wheels: [96, 330], wr: 31 },
  // Truck — cab plus open bed
  { body: 'M 20 104 L 34 66 L 74 44 L 196 42 L 226 68 L 236 78 L 236 62 L 400 62 L 404 116 L 20 116 Z',
    glass: 'M 52 66 L 80 50 L 190 48 L 206 66 Z', wheels: [98, 332], wr: 32 },
];

function CarSprite({ w = 190, squat = 0, spinning = false, bodyIdx = 0 }) {
  const B = BODY_PATHS[bodyIdx] || BODY_PATHS[0];
  return (
    // The car travels left-to-right, so the nose must point right. The artwork is
    // drawn nose-left, so the whole thing is mirrored here.
    <svg width={w} height={w * 0.40} viewBox="0 0 420 168" style={{ display: 'block', overflow: 'visible', transform: 'scaleX(-1)' }}>
      <defs>
        <linearGradient id="zpaint" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ffdf6b" />
          <stop offset="38%" stopColor="#f7c02a" />
          <stop offset="72%" stopColor="#d99a10" />
          <stop offset="100%" stopColor="#9c6c05" />
        </linearGradient>
        <linearGradient id="zwin" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#54677a" />
          <stop offset="100%" stopColor="#131b23" />
        </linearGradient>
      </defs>

      <g transform={`rotate(${-squat * 1.5} 300 128)`}>
        {/* main body: low nose, rising beltline, fastback tail */}
        <path d={B.body} fill="url(#zpaint)" stroke="#ffe89a" strokeWidth="2" strokeLinejoin="round" />

        {/* greenhouse */}
        <path d={B.glass} fill="url(#zwin)" />

        {/* body lines */}
        <path d="M 96 96 L 384 92" stroke="#8f6206" strokeWidth="1.6" opacity="0.65" />
        <path d="M 244 80 L 240 114" stroke="#8f6206" strokeWidth="1.6" opacity="0.5" />

        {/* lights */}
        <path d="M 24 98 L 54 94 L 54 102 L 24 104 Z" fill="#f2f7fa" opacity="0.92" />
        <path d="M 372 88 L 396 96 L 394 104 L 370 98 Z" fill="#cf3535" />

        {/* rocker + mirror */}
        <rect x="120" y="112" width="180" height="6" rx="3" fill="#7c5405" opacity="0.75" />
        <path d="M 170 62 L 158 58 L 170 56 Z" fill="#c9930c" />
      </g>

      {/* wheels sit on the road regardless of body attitude */}
      {B.wheels.map((cx, i) => (
        <g key={cx}>
          <circle cx={cx} cy={122} r={B.wr} fill="#0c1015" stroke="#333c46" strokeWidth="3" />
          <circle cx={cx} cy={122} r="17" fill="#242c35" stroke={spinning && i === 1 ? '#ff6a2c' : '#414b57'} strokeWidth="3" />
          {[0, 45, 90, 135].map((ang) => (
            <line key={ang}
              x1={cx - 14 * Math.cos((ang * Math.PI) / 180)} y1={122 - 14 * Math.sin((ang * Math.PI) / 180)}
              x2={cx + 14 * Math.cos((ang * Math.PI) / 180)} y2={122 + 14 * Math.sin((ang * Math.PI) / 180)}
              stroke="#525d69" strokeWidth="2.5" />
          ))}
        </g>
      ))}
      {/* wheel arch cutouts drawn over the body so the tyres read correctly */}
      {B.wheels.map((cx) => (
        <path key={cx} d={`M ${cx - B.wr} 116 A ${B.wr} ${B.wr} 0 0 1 ${cx + B.wr} 116`}
          fill="none" stroke="#8f6206" strokeWidth="3" />
      ))}
    </svg>
  );
}

// Christmas tree. Pre-stage and stage bulbs, three ambers, then green.
function LightTree({ phase }) {
  const bulb = (on, color, size = 15) => (
    <div style={{
      width: size, height: size, borderRadius: '50%', margin: '3px auto',
      background: on ? color : '#1a1f26',
      boxShadow: on ? `0 0 10px ${color}, 0 0 20px ${color}` : 'none',
      border: `1px solid ${on ? color : '#232a33'}`,
    }} />
  );
  return (
    <div style={{ width: 34, padding: '6px 4px', background: '#0a0d11', borderRadius: 8, border: `1px solid ${T.line}` }}>
      {bulb(phase >= 1, '#e8eef4', 9)}
      {bulb(phase >= 1, '#e8eef4', 9)}
      {bulb(phase === 2, '#ffb020')}
      {bulb(phase === 3, '#ffb020')}
      {bulb(phase === 4, '#ffb020')}
      {bulb(phase >= 5, '#22d36a')}
    </div>
  );
}

// Tyre smoke. Puffs are spawned at the rear wheel while it is spinning, then drift
// backwards and expand as they dissipate.
function Smoke({ puffs }) {
  return (
    <>
      {puffs.map((p) => (
        <div key={p.id} style={{
          position: 'absolute', left: p.x, bottom: p.y,
          width: p.r * 2, height: p.r * 2, borderRadius: '50%',
          background: `rgba(214,222,230,${p.a})`, filter: 'blur(4px)', pointerEvents: 'none',
        }} />
      ))}
    </>
  );
}

function DragStrip({ res, tNow, running, treePhase, bodyIdx }) {
  const [puffs, setPuffs] = useState([]);
  const puffId = useRef(0);

  let frac = 0, v = 0, gear = 1, spinning = false, rpm = 0, accel = 0;
  if (res) {
    const pt = res.trace.find((p) => p.t >= tNow) || res.trace[res.trace.length - 1];
    frac = clamp(pt.x / 402.336, 0, 1);
    v = pt.v * 2.23694; gear = pt.gear; spinning = pt.spinning; rpm = pt.rpm; accel = pt.a;
  }

  useEffect(() => {
    if (!running) { setPuffs([]); return undefined; }
    const id = setInterval(() => {
      setPuffs((prev) => {
        const moved = prev
          .map((p) => ({ ...p, x: p.x - 4, y: p.y + 1.2, r: p.r + 1.8, a: p.a - 0.05 }))
          .filter((p) => p.a > 0.02);
        if (spinning) {
          for (let i = 0; i < 3; i++) {
            moved.push({ id: puffId.current++, x: 26 + Math.random() * 30, y: 2 + Math.random() * 10,
              r: 6 + Math.random() * 6, a: 0.45 + Math.random() * 0.25 });
          }
        }
        return moved.slice(-45);
      });
    }, 40);
    return () => clearInterval(id);
  }, [running, spinning]);

  const squat = clamp(accel / 8, 0, 1);

  return (
    <Panel tight style={{ marginBottom: 12, overflow: 'hidden' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: T.ink3, fontFamily: T.mono, marginBottom: 5, letterSpacing: 0.6 }}>
        <span>START</span><span>60 FT</span><span>1/8</span><span>1/4 MILE</span>
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <LightTree phase={treePhase} />

        <div style={{
          position: 'relative', flex: 1, height: 150, borderRadius: 10, overflow: 'hidden',
          border: `1px solid ${T.line}`,
          background: 'linear-gradient(180deg,#070a0e 0%,#0d141c 34%,#1b232c 36%,#232c36 62%,#1a2029 100%)',
        }}>
          {/* far treeline / horizon glow */}
          <div style={{ position: 'absolute', left: 0, right: 0, top: 42, height: 14,
            background: 'linear-gradient(180deg,rgba(255,150,60,0.10),transparent)' }} />
          {/* guard wall */}
          <div style={{ position: 'absolute', left: 0, right: 0, top: 50, height: 10, background: '#2c343d',
            borderTop: '1px solid #3a444f' }} />
          {[...Array(16)].map((_, i) => (
            <div key={i} style={{ position: 'absolute', top: 50, height: 10, width: 2, background: '#1b222a',
              left: `${(i * 6.6 - ((frac * 260) % 6.6))}%` }} />
          ))}
          {/* track surface with centre groove */}
          <div style={{ position: 'absolute', left: 0, right: 0, top: 60, bottom: 0, background: '#12171d' }} />
          <div style={{ position: 'absolute', left: 0, right: 0, top: 92, height: 1, background: '#1e262f' }} />
          {/* moving surface texture conveys speed */}
          {[...Array(20)].map((_, i) => (
            <div key={i} style={{
              position: 'absolute', bottom: 10, height: 2, width: 22, background: '#232b34', borderRadius: 1,
              left: `${(((i * 6) - ((frac * 340) % 6)) % 108 + 108) % 108}%`,
            }} />
          ))}
          {/* distance boards */}
          {[[0.045, '60'], [0.5, '660']].map(([f, lbl]) => (
            <div key={lbl} style={{ position: 'absolute', left: `${f * 92}%`, top: 34, fontSize: 8,
              color: T.ink3, fontFamily: T.mono }}>{lbl}</div>
          ))}
          {/* finish line */}
          <div style={{ position: 'absolute', right: 4, top: 58, bottom: 6, width: 6,
            background: 'repeating-linear-gradient(180deg,#eef2f6 0 5px,#0f141a 5px 10px)' }} />

          {/* the car */}
          <div style={{ position: 'absolute', bottom: 14, left: `calc(${frac * 78}% + 4px)`, transition: 'left .04s linear' }}>
            <div style={{ position: 'relative' }}>
              <Smoke puffs={puffs} />
              <div style={{ filter: v > 100 ? 'blur(0.5px)' : 'none' }}>
                <CarSprite w={132} squat={squat} spinning={spinning} bodyIdx={bodyIdx} />
              </div>
            </div>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 9, fontFamily: T.mono, fontSize: 12.5 }}>
        <span style={{ color: T.ink, fontWeight: 700 }}>{v.toFixed(0)}<span style={{ color: T.ink3, fontSize: 10 }}> MPH</span></span>
        <span style={{ color: spinning ? T.red : T.ink2, fontWeight: 700 }}>{spinning ? 'WHEELSPIN' : `GEAR ${gear}`}</span>
        <span style={{ color: T.ink2 }}>{Math.round(rpm)}<span style={{ color: T.ink3, fontSize: 10 }}> RPM</span></span>
      </div>
    </Panel>
  );
}

function JourneyBanner({ step, onAdvance, onDismiss, onGoto }) {
  const j = JOURNEY[step];
  if (!j) return null;
  return (
    <div style={{ background: T.amberBg, border: `1px solid ${T.amber}`, borderRadius: 12, padding: '13px 14px', margin: '0 0 14px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ fontSize: 11, letterSpacing: 1, color: T.amberInk, fontWeight: 800 }}>{j.title.toUpperCase()}</div>
        <button onClick={onDismiss} style={{ background: 'none', border: 'none', color: T.ink3, fontSize: 10.5, fontWeight: 700, flexShrink: 0 }}>SKIP GUIDE</button>
      </div>
      <div style={{ fontSize: 12.5, color: '#c3cad2', lineHeight: 1.55, marginTop: 7 }}>{j.body}</div>
      <div style={{ display: 'flex', gap: 5, marginTop: 11, marginBottom: 10 }}>
        {JOURNEY.map((_, i) => (
          <div key={i} style={{ flex: 1, height: 3, borderRadius: 2, background: i <= step ? T.amber : T.line }} />
        ))}
      </div>
      <button onClick={onAdvance} style={{ width: '100%', padding: '11px 0', borderRadius: 9, border: 'none', background: T.amber, color: '#1a0f08', fontWeight: 800, fontSize: 12.5 }}>
        {j.cta}
      </button>
    </div>
  );
}

function BuildSection({ active, onClick, icon: Icon, label, sub, children }) {
  return (
    <div style={{ marginBottom: 9 }}>
      <button onClick={onClick} style={{
        width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '13px 14px',
        borderRadius: 11, border: `1px solid ${active ? T.amber : T.line}`, background: active ? T.amberBg : T.panel2,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, textAlign: 'left' }}>
          <div style={{ width: 32, height: 32, borderRadius: 9, background: active ? 'rgba(255,106,44,0.18)' : T.panel, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Icon size={16} color={active ? T.amberInk : T.ink2} />
          </div>
          <div>
            <div style={{ fontWeight: 800, fontSize: 13.5, color: active ? T.amberInk : T.ink }}>{label}</div>
            {sub && <div style={{ fontSize: 10.5, color: T.ink2, marginTop: 1 }}>{sub}</div>}
          </div>
        </div>
        <ChevronDown size={16} style={{ color: active ? T.amberInk : T.ink3, flexShrink: 0, marginLeft: 8, transform: active ? 'rotate(180deg)' : 'none', transition: 'transform .2s' }} />
      </button>
      <div style={{ maxHeight: active ? 3000 : 0, opacity: active ? 1 : 0, overflow: 'hidden', transition: 'max-height .35s ease, opacity .25s ease' }}>
        <div style={{ padding: '13px 2px 2px' }}>{children}</div>
      </div>
    </div>
  );
}

// Signature visual motif: a dial/gauge, used both as the static brand mark
// (Start screen) and as the live, RPM-driven readout (Dyno tab).
function DialMark({ size = 64, pct = 0.62, live = false }) {
  const angle = -120 + pct * 240;
  return (
    <svg viewBox="0 0 100 100" width={size} height={size}>
      <circle cx="50" cy="50" r="44" fill={T.panel2} stroke={T.line} strokeWidth="1.5" />
      {Array.from({ length: 13 }).map((_, i) => {
        const a = (-120 + (i / 12) * 240) * (Math.PI / 180);
        const inner = 34, outer = i % 3 === 0 ? 28 : 31;
        return (
          <line key={i}
            x1={50 + inner * Math.sin(a)} y1={50 - inner * Math.cos(a)}
            x2={50 + outer * Math.sin(a)} y2={50 - outer * Math.cos(a)}
            stroke={i > 9 ? T.red : T.line === T.line ? '#3a4149' : T.line} strokeWidth={i % 3 === 0 ? 1.6 : 1} />
        );
      })}
      <g style={{ transition: live ? 'none' : 'transform .6s cubic-bezier(.34,1.4,.64,1)' }} transform={`rotate(${angle} 50 50)`}>
        <line x1="50" y1="50" x2="50" y2="20" stroke={T.amber} strokeWidth="3" strokeLinecap="round" />
      </g>
      <circle cx="50" cy="50" r="5" fill={T.amber} />
    </svg>
  );
}

function Tach({ rpm, cylinders, running }) {
  const pct = clamp(rpm / 7500, 0, 1);
  const zoneColor = pct > 0.93 ? T.red : pct > 0.75 ? T.yellow : T.green;
  return (
    <Panel style={{ textAlign: 'center', background: T.panel }}>
      <style>{`@keyframes cylpulse{0%,100%{opacity:.25;transform:scaleY(.6)}50%{opacity:1;transform:scaleY(1)}}`}</style>
      <div style={{ position: 'relative', display: 'inline-block' }}>
        <DialMark size={168} pct={pct} live={running} />
        <div style={{ position: 'absolute', top: '58%', left: '50%', transform: 'translate(-50%,-50%)', textAlign: 'center' }}>
          <div style={{ fontSize: 26, fontWeight: 800, fontFamily: T.mono, color: T.ink }}>{Math.round(rpm)}</div>
          <div style={{ fontSize: 8.5, color: T.ink3, letterSpacing: 1.5, fontWeight: 700 }}>RPM</div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 4, justifyContent: 'center', marginTop: 8, height: 26 }}>
        {Array.from({ length: cylinders }).map((_, i) => (
          <div key={i} style={{
            width: 8, height: 24, borderRadius: 2, background: zoneColor,
            animation: running ? `cylpulse ${Math.max(0.12, 50 / Math.max(rpm, 500))}s ease-in-out infinite` : 'none',
            animationDelay: `${i * (0.5 / cylinders)}s`, opacity: running ? undefined : 0.3,
          }} />
        ))}
      </div>
    </Panel>
  );
}

// rowIdx lets a caller show only the load rows the engine can physically reach.
// A naturally aspirated engine never sees above ~101 kPa, so showing 150/200 kPa
// rows would be inviting the player to tune cells that can never be used.
// Selection supports single cells, whole rows/columns, and rectangular RANGES.
// Range editing is how real tuning software works — you almost never adjust one
// cell at a time, you grab a region and move it together.
function TuningGrid({ data, setData, min, max, decimals, selection, setSelection, rowIdx, rangeMode }) {
  const fmt = (v) => (decimals ? v.toFixed(decimals) : Math.round(v));
  const selectCell = (row, col) => {
    if (!rangeMode) { setSelection({ type: 'cell', row, col }); return; }
    // First tap sets an anchor; second tap completes the rectangle.
    if (!selection || selection.type !== 'range' || selection.complete) {
      setSelection({ type: 'range', r1: row, c1: col, r2: row, c2: col, complete: false });
    } else {
      setSelection({ ...selection, r2: row, c2: col, complete: true });
    }
  };
  const selectRow = (row) => setSelection({ type: 'row', row });
  const selectCol = (col) => setSelection({ type: 'col', col });
  const isSelected = (row, col) => {
    if (!selection) return false;
    if (selection.type === 'cell') return selection.row === row && selection.col === col;
    if (selection.type === 'row') return selection.row === row;
    if (selection.type === 'col') return selection.col === col;
    if (selection.type === 'range') {
      const [ra, rb] = [Math.min(selection.r1, selection.r2), Math.max(selection.r1, selection.r2)];
      const [ca, cb] = [Math.min(selection.c1, selection.c2), Math.max(selection.c1, selection.c2)];
      return row >= ra && row <= rb && col >= ca && col <= cb;
    }
    return false;
  };
  return (
    <div>
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9.5, color: T.ink3, fontWeight: 700, letterSpacing: 0.8, marginBottom: 4 }}>
      <span>MAP kPa &darr;</span><span>RPM &rarr;</span>
    </div>
    <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch', border: `1px solid ${T.line}`, borderRadius: 10 }}>
      <div style={{ display: 'inline-block', minWidth: '100%' }}>
        <div style={{ display: 'flex' }}>
          <div style={{ width: 44, flexShrink: 0, background: T.panel }} />
          {RPM.map((r, ci) => (
            <button key={r} onClick={() => selectCol(ci)} style={{
              width: 51, height: 30, flexShrink: 0, border: 'none', borderBottom: `1px solid ${T.line}`, borderLeft: `1px solid ${T.line}`,
              background: selection?.type === 'col' && selection.col === ci ? T.amber : T.panel,
              color: selection?.type === 'col' && selection.col === ci ? '#1a0f08' : T.ink2,
              fontFamily: T.mono, fontSize: 10, fontWeight: 700,
            }}>{r}</button>
          ))}
        </div>
        {(rowIdx ?? LOAD.map((_, i) => i)).map((ri) => LOAD[ri]).map((load, idx) => {
          const ri = (rowIdx ?? LOAD.map((_, i) => i))[idx];
          return (
          <div key={load} style={{ display: 'flex' }}>
            <button onClick={() => selectRow(ri)} style={{
              width: 44, height: 37, flexShrink: 0, border: 'none', borderRight: `1px solid ${T.line}`, borderTop: `1px solid ${T.line}`,
              background: selection?.type === 'row' && selection.row === ri ? T.amber : T.panel,
              color: selection?.type === 'row' && selection.row === ri ? '#1a0f08' : T.ink2,
              fontFamily: T.mono, fontSize: 10, fontWeight: 700,
            }}>{load}</button>
            {data[ri].map((val, ci) => (
              <button key={ci} onClick={() => selectCell(ri, ci)} style={{
                width: 51, height: 37, flexShrink: 0,
                border: isSelected(ri, ci) ? `2px solid ${T.ink}` : `1px solid rgba(0,0,0,0.35)`,
                background: heat(val, min, max), color: '#f2f5f7',
                fontFamily: T.mono, fontSize: 12, fontWeight: 700,
              }}>{fmt(val)}</button>
            ))}
          </div>
          );
        })}
      </div>
    </div>
    </div>
  );
}

// Reference data for a selected cell. Deliberately DESCRIPTIVE, not predictive:
// it tells you what this parameter does and what range is normal here, but never
// simulates an outcome — only a real dyno pull produces results in this sandbox.
function cellReference(kind, row, col, value, turboOn) {
  const rpm = RPM[col], map = LOAD[row];
  const boosted = map > 105, wot = map >= 95, cruise = map <= 70;
  const highRpm = rpm >= 5500, lowRpm = rpm <= 2500;
  if (kind === 've') {
    const typical = boosted ? '95-110%' : wot ? (highRpm ? '80-95%' : lowRpm ? '60-75%' : '90-100%') : (cruise ? '55-80%' : '75-90%');
    return {
      what: 'Cylinder filling efficiency at this manifold pressure — how completely the cylinder fills relative to the pressure available.',
      typical: `Typical here: ${typical}.`,
      affects: 'Feeds the air-mass calculation (airCharge = VE x V_cyl x MAP/RT). Raising it raises fuel demand and pulse width at this point.',
      note: boosted ? 'Above ~105 kPa you are in boost — these rows only get used once a turbo is fitted.' : null,
    };
  }
  if (kind === 'timing') {
    const typical = boosted ? '14-24°' : wot ? (lowRpm ? '12-20°' : highRpm ? '28-38°' : '22-32°') : '32-45°';
    return {
      what: 'Spark advance before top dead center, aiming to land peak cylinder pressure ~16° after TDC.',
      typical: `Typical here: ${typical}. Low manifold pressure tolerates far more advance; boost tolerates much less.`,
      affects: 'Torque rises toward MBT then flattens. Beyond the knock limit the ECU pulls it back during the pull.',
      note: boosted && value > 28 ? 'Aggressive for a boosted cell — cylinder pressure is already high here.' : null,
    };
  }
  const typical = boosted ? '11.5-12.3:1' : wot ? '12.5-13.2:1' : cruise ? '14.7:1 (stoich, closed loop)' : '13.5-14.5:1';
  return {
    what: 'Commanded air:fuel ratio, gasoline-equivalent. Divide by 14.7 for lambda.',
    typical: `Typical here: ${typical}.`,
    affects: 'Sets fuel mass, and therefore pulse width and duty cycle. Richer cools combustion and resists knock; leaner raises EGT and knock risk.',
    note: boosted && value > 12.8 ? 'Lean for a boosted cell — this is where lean mixtures burn pistons.' : cruise && value < 14 ? 'Richer than needed for cruise — wastes fuel with no power gain at this load.' : null,
  };
}

function SelectionDock({ data, setData, selection, min, max, decimals, unit, onClose, kind, turboOn }) {
  if (!selection) return null;
  // Resolve any selection shape to the list of cells it covers, so every edit
  // operation below works identically for one cell or a hundred.
  const cellsIn = () => {
    const out = [];
    if (selection.type === 'cell') out.push([selection.row, selection.col]);
    else if (selection.type === 'row') data[selection.row].forEach((_, c) => out.push([selection.row, c]));
    else if (selection.type === 'col') data.forEach((_, r) => out.push([r, selection.col]));
    else if (selection.type === 'range') {
      const [ra, rb] = [Math.min(selection.r1, selection.r2), Math.max(selection.r1, selection.r2)];
      const [ca, cb] = [Math.min(selection.c1, selection.c2), Math.max(selection.c1, selection.c2)];
      for (let r = ra; r <= rb; r++) for (let c = ca; c <= cb; c++) out.push([r, c]);
    }
    return out;
  };
  const cells = cellsIn();
  const current = cells.reduce((sum, [r, c]) => sum + data[r][c], 0) / Math.max(cells.length, 1);

  // Add a fixed amount to every selected cell.
  const apply = (delta) => {
    const next = clone2D(data);
    cells.forEach(([r, c]) => { next[r][c] = Number(clamp(next[r][c] + delta, min, max).toFixed(2)); });
    setData(next);
  };
  // Scale every selected cell by a percentage. This is the operation tuners use
  // most on a VE table, because airflow errors are proportional, not absolute.
  const scale = (pct) => {
    const next = clone2D(data);
    cells.forEach(([r, c]) => { next[r][c] = Number(clamp(next[r][c] * (1 + pct / 100), min, max).toFixed(2)); });
    setData(next);
  };
  // Set every selected cell to the same value.
  const setAbs = (v) => {
    const next = clone2D(data);
    cells.forEach(([r, c]) => { next[r][c] = clamp(v, min, max); });
    setData(next);
  };
  // Smooth the selection toward its own average — removes spikes a histogram
  // correction can leave behind, exactly like the "smooth" tool in real software.
  const smooth = () => {
    const next = clone2D(data);
    const avg = cells.reduce((sum, [r, c]) => sum + data[r][c], 0) / Math.max(cells.length, 1);
    cells.forEach(([r, c]) => { next[r][c] = Number(clamp(data[r][c] * 0.5 + avg * 0.5, min, max).toFixed(2)); });
    setData(next);
  };
  const smallStep = decimals ? 0.1 : 1;
  const bigStep = decimals ? 1 : 5;
  let sel = 'Cell';
  if (selection.type === 'row') sel = `Row · ${LOAD[selection.row]} kPa MAP`;
  else if (selection.type === 'col') sel = `Column · ${RPM[selection.col]} RPM`;
  else if (selection.type === 'range') {
    const [ra, rb] = [Math.min(selection.r1, selection.r2), Math.max(selection.r1, selection.r2)];
    const [ca, cb] = [Math.min(selection.c1, selection.c2), Math.max(selection.c1, selection.c2)];
    sel = selection.complete
      ? `${cells.length} cells · ${RPM[ca]}-${RPM[cb]} RPM · ${LOAD[rb]}-${LOAD[ra]} kPa`
      : 'Tap a second cell to complete the range';
  } else sel = `${RPM[selection.col]} RPM · ${LOAD[selection.row]} kPa MAP`;

  return (
    <div style={{ position: 'sticky', bottom: 0, background: T.panel, borderTop: `1px solid ${T.line}`, padding: '11px 14px 13px', boxShadow: '0 -8px 20px rgba(0,0,0,0.45)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 7 }}>
        <div>
          <div style={{ fontSize: 10, letterSpacing: 1, color: T.ink2, textTransform: 'uppercase', fontWeight: 700 }}>{sel}</div>
          <div style={{ fontFamily: T.mono, fontSize: 23, fontWeight: 800, color: T.ink }}>
            {decimals ? current.toFixed(decimals) : Math.round(current)}<span style={{ fontSize: 12, color: T.ink2, marginLeft: 4 }}>{unit}</span>
          </div>
        </div>
        <button onClick={onClose} style={{ color: T.ink2, background: T.panel2, border: `1px solid ${T.line}`, borderRadius: 7, fontSize: 11.5, fontWeight: 700, padding: '8px 14px' }}>DONE</button>
      </div>
      {selection.type === 'cell' && kind && (() => {
        const ref = cellReference(kind, selection.row, selection.col, current, turboOn);
        return (
          <div style={{ background: T.panel2, border: `1px solid ${T.line}`, borderRadius: 9, padding: '9px 11px', marginBottom: 9, fontSize: 11.5, lineHeight: 1.55, color: '#a5aebb' }}>
            <div style={{ fontSize: 9.5, letterSpacing: 1, color: T.cyan, fontWeight: 800, marginBottom: 5 }}>REFERENCE · {RPM[selection.col]} RPM / {LOAD[selection.row]} kPa</div>
            <div>{ref.what}</div>
            <div style={{ marginTop: 4, color: T.ink }}>{ref.typical}</div>
            <div style={{ marginTop: 4 }}><b style={{ color: '#c3cad2' }}>Affects: </b>{ref.affects}</div>
            {ref.note && <div style={{ marginTop: 4, color: T.yellow }}>{ref.note}</div>}
          </div>
        );
      })()}
      <input type="range" min={min} max={max} step={smallStep} value={current} onChange={(e) => setAbs(Number(e.target.value))} style={{ width: '100%', accentColor: T.amber }} />
      <div style={{ display: 'flex', gap: 7, marginTop: 9 }}>
        {[-bigStep, -smallStep, smallStep, bigStep].map((d, i) => (
          <button key={i} onClick={() => apply(d)} style={{
            flex: 1, padding: '11px 0', borderRadius: 8, border: `1px solid ${T.line}`, background: T.panel2,
            color: d < 0 ? '#ff9d7a' : T.green, fontWeight: 800, fontFamily: T.mono, fontSize: 13,
          }}>{d > 0 ? '+' : ''}{d}</button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 7, marginTop: 7 }}>
        {[-5, -2, 2, 5].map((p) => (
          <button key={p} onClick={() => scale(p)} style={{
            flex: 1, padding: '10px 0', borderRadius: 8, border: `1px solid ${T.line}`, background: T.panel,
            color: p < 0 ? '#ff9d7a' : T.cyan, fontWeight: 800, fontFamily: T.mono, fontSize: 12,
          }}>{p > 0 ? '+' : ''}{p}%</button>
        ))}
        <button onClick={smooth} style={{
          flex: 1, padding: '10px 0', borderRadius: 8, border: `1px solid ${T.line}`, background: T.panel,
          color: T.violet, fontWeight: 800, fontSize: 11,
        }}>SMOOTH</button>
      </div>
    </div>
  );
}

const TUTORIAL_STEPS = [
  { title: 'An engine is an air pump',
    body: 'Power comes from burning fuel, and you can only burn as much fuel as you have air to burn it with. Every part you fit and every number you edit is ultimately about one of three things: how much air gets in, how much fuel joins it, and when you light the mixture.' },

  { title: 'The one equation everything rests on',
    body: 'The ECU works out how much air is in the cylinder using the ideal gas law:\n\n    ρ = MAP ÷ (R × T)\n    airCharge = VE × V_cylinder × ρ\n\nMAP is manifold pressure, T is charge temperature in kelvin, R is a constant for air. VE — volumetric efficiency — is how completely the cylinder fills. That last number is the one you tune on the AIR table.' },

  { title: 'Why the AIR table changes your power',
    body: 'Raise a VE cell and the ECU believes more air is present, so it injects more fuel, so more energy is released and torque goes up. But VE is not a wish — it describes what the hardware actually does. Put in a number the engine cannot deliver and the mixture goes wrong, because the ECU is now fuelling for air that is not there.' },

  { title: 'Fuel follows from air, not the other way round',
    body: 'Once air mass is known, fuel is pure arithmetic:\n\n    fuelMass = airCharge ÷ (λ × stoichRatio)\n\nλ (lambda) is your mixture target from the FUEL table. Best power is about λ0.87, richer under boost. stoichRatio is a property of the fuel: 14.7 for gasoline, 9.8 for E85 — which is why E85 needs roughly 1.5× the fuel mass for the same lambda.' },

  { title: 'The ECU commands time, not fuel',
    body: 'It converts fuel mass into an injector pulse width:\n\n    PW = fuelMass ÷ (injectorCC × density ÷ 60000) + deadtime\n    cycleTime = 120000 ÷ RPM\n    duty% = PW ÷ cycleTime × 100\n\nAt 7500 RPM a cycle is only 16 ms. Past about 90% duty there is no time left, and the mixture goes lean no matter what your FUEL table says. That is a physical wall, not a calibration choice.' },

  { title: 'Spark decides how much of that energy you keep',
    body: 'Fuel burns over a few milliseconds, so you light it before top dead center and aim for peak pressure just after. Too early and pressure fights the rising piston; too late and you are burning into an escaping piston.\n\n    timingEff = 1 − 0.0016 × (yourTiming − MBT)²\n\nThat is why the SPARK table changes power without changing a single thing about airflow — it changes how much of the same burn reaches the crank.' },

  { title: 'Knock is the limit on all of it',
    body: 'The end gas can self-ignite from heat and pressure before the flame reaches it. The sim computes a knock ceiling from charge mass, octane, compression, intake temperature and mixture. Ask for more timing than that ceiling and the ECU pulls it back — you see commanded and actual diverge in the datalog, and the power you thought you gained disappears.' },

  { title: 'Where the horsepower number actually comes from',
    body: 'Nothing in this sim adds horsepower directly. Torque is derived last:\n\n    IMEP = fuelMass × LHV × η × timingEff × afrEff ÷ V_cyl\n    BMEP = IMEP − FMEP\n    torque = BMEP × Vd ÷ 4π\n\nη comes from your compression ratio. FMEP is what the engine spends on friction, pumping and valve springs. Change anything upstream and the dyno number changes — exactly like a real engine.' },

  { title: 'So what is tuning?',
    body: 'Tuning is finding, for every RPM and load point, the most timing and the best mixture the engine will tolerate without knocking or running out of fuel. Too conservative and you leave torque on the table. Too aggressive and you damage it. The optimum is a narrow band, and it moves the instant you change hardware.' },

  { title: 'The method: change, pull, read, adjust',
    body: 'Change one thing. Run a pull — nothing is simulated until you do. Read the log before the power number: a gap between commanded and actual is the ECU telling you something. Adjust, pull again, compare. Tuners who change three things at once cannot tell which one worked.' },

  { title: 'Calibration faults vs physical limits',
    body: 'Knock, mixture errors, MAF drift and injector scaling are calibration problems — the tables fix them completely. Injectors out of duty cycle, valve float, a compressor past its range: those are hardware, and no table edit touches them. The log always tells you which kind you are looking at, and that distinction is most of the skill.' },

  { title: 'You can hear the physics too',
    body: 'Engine sound here is generated from the same numbers, not sampled. Each cylinder firing schedules an exhaust pulse:\n\n    firingHz = RPM ÷ 60 × cylinders ÷ 2\n\nA cross-plane V8 fires unevenly within each bank, and that irregular spacing is what makes it rumble. A V6 fires evenly and rings hard and hornlike. A four fires only twice per revolution, so you hear each pulse separately.\n\nRetard the timing and it turns raspy, because the charge is still burning into the exhaust. Richen it and it softens. Fit a big cam and it lopes. Add a turbo to a small engine and induction noise takes over. Tuners diagnose by ear for a reason — the sound is data.' },

  { title: 'Where this physics comes from',
    body: 'Every relation in this simulator is standard published engineering, and each figure has been checked against a source rather than assumed.\n\nMIT OpenCourseWare 8.21 gives the Otto-cycle efficiency and, critically, the value of gamma to use: about 1.3 for combustion products at cycle temperature, which yields 50% ideal efficiency at a 10:1 compression ratio. This app originally used 1.35 and was corrected to match.\n\nNASA Glenn provides the underlying pressure and temperature relations that efficiency formula derives from. x-engineer.org confirms the foundation the whole model rests on: one engine cycle is two crank rotations, and only the power stroke produces energy.\n\nEvery formula was also checked for unit consistency. Air density resolves to 1.185 kg/m3 at sea level and 25 C against a published 1.184, and injector cycle time derives exactly from two crank revolutions.\n\nThe full source list, including what checking them changed, is under Learn on the HOME tab. If a number here looks wrong to you, go and check it — that instinct has already corrected real errors in this simulator.' },

  { title: 'Then put it in a car',
    body: 'A torque curve is only half of acceleration. On the DRAG page the engine goes into a car and runs a quarter mile, and everything you choose there is real physics:\n\n    wheelTorque = engineTorque x gearRatio x finalDrive\n    F_max = mu x N            (grip ceiling)\n    dN = m x a x h / L        (weight transfer)\n    F_aero = 0.5 x rho x Cd x A x v^2\n\nGearing multiplies torque and divides speed by exactly the same amount. Grip sets a hard ceiling on acceleration no matter how much power you have — street tyres measure 0.8-0.9, slicks 1.7-1.9. Aerodynamic drag rises with the square of speed, so it is nothing at the line and everything at the trap.\n\nThat is why trap speed measures power while sixty-foot time measures traction, and why the fastest engine does not always win.' },

  { title: 'Ready',
    body: 'Sandbox lets you build and tune anything with no objectives. Career hands you customer cars with real faults to diagnose. Either way the loop is the same: build it, calibrate it, listen to it, measure it, then do it better.' },
];

function TutorialScreen({ onDone }) {
  const [step, setStep] = useState(0);
  const s = TUTORIAL_STEPS[step];
  const last = step === TUTORIAL_STEPS.length - 1;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100dvh', background: T.bg, color: T.ink, fontFamily: T.sans }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 16px' }}>
        <div style={{ fontSize: 10.5, letterSpacing: 1.5, color: T.amberInk, fontWeight: 800 }}>TUTORIAL · {step + 1}/{TUTORIAL_STEPS.length}</div>
        <button onClick={onDone} style={{ background: 'none', border: 'none', color: T.ink3, fontSize: 12, fontWeight: 700 }}>SKIP</button>
      </div>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '0 24px' }}>
        <div style={{ fontSize: 21, fontWeight: 800, marginBottom: 13, letterSpacing: -0.3 }}>{s.title}</div>
        <div style={{ fontSize: 14.5, color: '#c3cad2', lineHeight: 1.7 }}>
          {s.body.split('\n').map((ln, i) => {
            const isFormula = ln.startsWith('    ');
            if (ln.trim() === '') return <div key={i} style={{ height: 9 }} />;
            return isFormula
              ? <div key={i} style={{ fontFamily: T.mono, color: T.cyan, fontSize: 12.5, lineHeight: 1.6 }}>{ln.trim()}</div>
              : <div key={i}>{ln}</div>;
          })}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6, justifyContent: 'center', padding: '0 0 18px' }}>
        {TUTORIAL_STEPS.map((_, i) => (
          <div key={i} style={{ width: i === step ? 20 : 6, height: 6, borderRadius: 3, background: i === step ? T.amber : T.line, transition: 'width .2s' }} />
        ))}
      </div>
      <div style={{ display: 'flex', gap: 10, padding: '0 16px', paddingBottom: 'calc(16px + env(safe-area-inset-bottom))' }}>
        {step > 0 && (
          <button onClick={() => setStep((v) => v - 1)} style={{ flex: 1, padding: '15px 0', borderRadius: 12, border: `1px solid ${T.line}`, background: T.panel2, color: '#c3cad2', fontWeight: 700, fontSize: 14 }}>BACK</button>
        )}
        <button onClick={() => (last ? onDone() : setStep((v) => v + 1))} style={{ flex: 2, padding: '15px 0', borderRadius: 12, border: 'none', background: T.amber, color: '#1a0f08', fontWeight: 800, fontSize: 14.5 }}>
          {last ? 'START TUNING' : 'NEXT'}
        </button>
      </div>
    </div>
  );
}

function StartScreen({ onStart, onCareer, onTutorial }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100dvh', background: T.bg, color: T.ink, fontFamily: T.sans, justifyContent: 'center', alignItems: 'center', padding: 24, textAlign: 'center', position: 'relative', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', top: '-15%', left: '50%', transform: 'translateX(-50%)', width: 420, height: 420, borderRadius: '50%', background: 'radial-gradient(circle, rgba(255,106,44,0.10) 0%, transparent 70%)' }} />
      <div style={{ marginBottom: 22, position: 'relative' }}><DialMark size={92} pct={0.62} /></div>
      <div style={{ fontSize: 11, letterSpacing: 3, color: T.amberInk, fontWeight: 800, marginBottom: 7 }}>CARIBOU TUNING</div>
      <div style={{ fontSize: 25, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.3, marginBottom: 15, maxWidth: 320 }}>Engine Management Sandbox</div>
      <div style={{ fontSize: 13.5, color: T.ink2, lineHeight: 1.65, maxWidth: 300, marginBottom: 34 }}>
        Design an engine. Tune it. Log it. Improve it. A free-tune sandbox built to teach real engine management, not just move sliders.
      </div>
      <button onClick={onCareer} style={{ width: '100%', maxWidth: 300, padding: '16px 0', borderRadius: 12, border: 'none', background: T.amber, color: '#1a0f08', fontWeight: 800, fontSize: 15, letterSpacing: 0.4, marginBottom: 10, boxShadow: '0 8px 24px rgba(255,106,44,0.25)' }}>
        CAREER
      </button>
      <div style={{ fontSize: 11, color: T.ink3, marginBottom: 14, maxWidth: 300 }}>Customer cars with real faults to diagnose</div>
      <button onClick={onStart} style={{ width: '100%', maxWidth: 300, padding: '15px 0', borderRadius: 12, border: `1px solid ${T.line}`, background: T.panel2, color: T.ink, fontWeight: 700, fontSize: 14, marginBottom: 10 }}>
        SANDBOX
      </button>
      <div style={{ fontSize: 11, color: T.ink3, marginBottom: 14, maxWidth: 300 }}>Build and tune anything, no objectives</div>
      <button onClick={onTutorial} style={{ width: '100%', maxWidth: 300, padding: '15px 0', borderRadius: 12, border: `1px solid ${T.line}`, background: 'none', color: '#c3cad2', fontWeight: 700, fontSize: 13.5 }}>
        TUTORIAL
      </button>
      <div style={{ fontSize: 10.5, color: T.ink3, marginTop: 18, fontFamily: T.mono }}>{BUILD_VERSION}</div>
    </div>
  );
}

function LiveGauge({ label, value, unit, color = T.ink, warn }) {
  return (
    <div style={{ flex: 1, minWidth: 68, background: T.panel, border: `1px solid ${warn ? T.red : T.line}`, borderRadius: 9, padding: '8px 9px' }}>
      <div style={{ fontSize: 8.5, color: T.ink2, letterSpacing: 0.8, fontWeight: 700 }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 800, fontFamily: T.mono, color: warn ? T.red : color }}>
        {value}<span style={{ fontSize: 9, color: T.ink3, marginLeft: 2 }}>{unit}</span>
      </div>
    </div>
  );
}

function TrimBar({ label, value }) {
  const pct = clamp((value + 25) / 50, 0, 1) * 100;
  const c = Math.abs(value) > 15 ? T.red : Math.abs(value) > 8 ? T.yellow : T.green;
  return (
    <div style={{ marginBottom: 7 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9.5, color: T.ink2, fontWeight: 700, marginBottom: 3 }}>
        <span>{label}</span><span style={{ color: c, fontFamily: T.mono }}>{value > 0 ? '+' : ''}{value.toFixed(1)}%</span>
      </div>
      <div style={{ height: 5, background: T.panel, borderRadius: 3, position: 'relative', border: `1px solid ${T.line}` }}>
        <div style={{ position: 'absolute', left: '50%', top: -1, bottom: -1, width: 1, background: T.lineHi }} />
        <div style={{ position: 'absolute', left: `${Math.min(50, pct)}%`, width: `${Math.abs(pct - 50)}%`, top: 0, bottom: 0, background: c, borderRadius: 2 }} />
      </div>
    </div>
  );
}

// ============================================================
export default function EngineManagementSandbox() {
  const [appView, setAppView] = useState('start');
  const [tab, setTab] = useState('dash');
  const [engineConfig, setEngineConfig] = useState(DEFAULT_ENGINE_CONFIG);
  const [mods, setMods] = useState(DEFAULT_MODS);
  const [ve, setVe] = useState(() => computeHardwareVE(DEFAULT_ENGINE_CONFIG, DEFAULT_MODS));
  const [timing, setTiming] = useState(clone2D(DEFAULT_TIMING));
  const [afr, setAfr] = useState(clone2D(DEFAULT_AFR));
  const [turboOn, setTurboOn] = useState(false);
  const [boostCurve, setBoostCurve] = useState([...DEFAULT_BOOST]);
  const [octaneIdx, setOctaneIdx] = useState(0);
  const [injIdx, setInjIdx] = useState(0);
  const [mafScalar, setMafScalar] = useState(1.0);
  const [loadKpa, setLoadKpa] = useState(100);
  const [health, setHealth] = useState({ piston: 100, bearing: 100, valve: 100 });
  const [selection, setSelection] = useState(null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [prevResult, setPrevResult] = useState(null);
  const [revealCount, setRevealCount] = useState(0);
  const [bestScore, setBestScore] = useState(0);
  const [totalScore, setTotalScore] = useState(0);
  const [pullCount, setPullCount] = useState(0);
  const [turbineIdx, setTurbineIdx] = useState(1);
  const [compressorIdx, setCompressorIdx] = useState(1);
  const [exhaustDiaIdx, setExhaustDiaIdx] = useState(1);
  const [buildSection, setBuildSection] = useState('engine');
  const [ecuInjectorCc, setEcuInjectorCc] = useState(315);
  const [tuneView, setTuneView] = useState('ve');
  const [rangeMode, setRangeMode] = useState(false);
  const [boostSel, setBoostSel] = useState(4);
  const [dynoView, setDynoView] = useState('result');
  // A dyno pull is a sequence, not just a sweep: settle at idle, sweep up under
  // load, let it spin back down, settle again. Those bookends make the pull feel
  // like a real session and give the audio somewhere to breathe.
  const [dynoPhase, setDynoPhase] = useState(null); // 'settle' | 'sweep' | 'spooldown' | 'rest'
  const [dynoRpm, setDynoRpm] = useState(800);
  const [car, setCar] = useState({ ...DEFAULT_CAR });
  const [dragResult, setDragResult] = useState(null);
  const [dragRunning, setDragRunning] = useState(false);
  const [dragT, setDragT] = useState(0);
  const [treePhase, setTreePhase] = useState(0); // 0 idle, 1 staged, 2-4 ambers, 5 green
  const dragTimer = useRef(null);
  const [histogram, setHistogram] = useState(null);
  const [live, setLive] = useState(() => makeLiveState());
  const [throttleInput, setThrottleInput] = useState(0);
  const [dashSection, setDashSection] = useState('career');
  // Guided first run: BUILD -> TUNE -> LIVE -> DYNO, then free play (step 4).
  const [journeyStep, setJourneyStep] = useState(0);
  const [mode, setMode] = useState('sandbox');       // 'sandbox' | 'career'
  const [activeJob, setActiveJob] = useState(null);  // index into CAREER_JOBS
  const [completedJobs, setCompletedJobs] = useState([]);
  const [jobResult, setJobResult] = useState(null);  // 'pass' | 'fail' after a pull
  const revealTimer = useRef(null);
  const liveTimer = useRef(null);
  const liveCfgRef = useRef(null);
  const throttleRef = useRef(0);
  const audioRef = useRef(null);
  const liveRef = useRef(makeLiveState());
  const uiTickRef = useRef(0);
  const overlapRef = useRef(0);
  const tabRef = useRef('dash');
  const cylRef = useRef(6);
  const dispRef = useRef(3.5);
  const [soundOn, setSoundOn] = useState(true);
  const [audioStatus, setAudioStatus] = useState(null); // null | 'ok' | 'blocked' | 'unavailable'
  const [volume, setVolume] = useState(1.0); // player-facing master volume

  const octaneBonus = OCTANE_OPTS[octaneIdx].bonus;
  const engineDerived = useMemo(() => deriveEngine(engineConfig), [engineConfig]);
  const idealExhaustDia = useMemo(() => idealExhaustDiameter(engineDerived.displacementL, turboOn ? Math.max(...boostCurve) : 0), [engineDerived, turboOn, boostCurve]);
  const exhaustDiaError = EXHAUST_DIA_OPTS[exhaustDiaIdx].dia - idealExhaustDia;
  const mafErrorBase = useMemo(() => {
    let e = 1.0;
    if (mods.intake) e *= 0.90;
    if (turboOn) e *= 0.92;
    return e;
  }, [mods.intake, turboOn]);

  const fuel = OCTANE_OPTS[octaneIdx];
  const injectorCc = INJECTOR_OPTS[injIdx].cc;

  // Every hardware choice that physically changes how the engine breathes feeds the
  // VE table: bore/stroke, cylinder count, compression, cam duration, valve springs,
  // head material, bolt-ons, exhaust diameter, turbine backpressure, and the fuel's
  // charge-cooling effect.
  //
  // The table is NEVER rewritten silently. Changing hardware leaves your logged VE
  // stale — exactly as it would in a real shop, where the old log does not update
  // itself because you bolted something on. The VE tab shows what changed and by how
  // much, and you choose when to accept it.
  const hwForVe = useMemo(() => ({
    turboOn,
    turbine: turboOn ? TURBINE_OPTS[turbineIdx] : null,
    exhaustDia: EXHAUST_DIA_OPTS[exhaustDiaIdx].dia,
    fuel,
  }), [turboOn, turbineIdx, exhaustDiaIdx, fuel]);

  const recalcVE = () => setVe(computeHardwareVE(engineConfig, mods, hwForVe));
  const calAdvice = useMemo(() => calibrationAdvice({
    ve, timing, afr, derived: engineDerived, octaneBonus, fuel, mods, turboOn, boostCurve,
    compressor: COMPRESSOR_OPTS[compressorIdx], turbine: TURBINE_OPTS[turbineIdx],
    injectorCc, ecuInjectorCc, mafScalar, mafErrorBase,
  }), [ve, timing, afr, engineDerived, octaneBonus, fuel, mods, turboOn, boostCurve,
       compressorIdx, turbineIdx, injectorCc, ecuInjectorCc, mafScalar, mafErrorBase]);

  // What the hardware actually flows. The player's `ve` table is the ECU's ESTIMATE;
  // this is the reality it is estimating. The gap between the two is what a wideband
  // sees, and what the fuel-trim histogram measures.
  const veTrueTable = useMemo(() => computeHardwareVE(engineConfig, mods, hwForVe), [engineConfig, mods, hwForVe]);

  const veAdvice = useMemo(
    () => veRecommendations(ve, engineConfig, mods, hwForVe),
    [ve, engineConfig, mods, hwForVe]
  );

  // Same real-units chain the sim uses, evaluated at WOT / 6500 RPM as a preview.
  const dutyPreview = useMemo(() => {
    const rpm = 6500;
    const boostPsi = turboOn ? boostCurve[RPM.indexOf(6500)] : 0;
    const mapKpa = BARO_KPA + boostPsi * PSI_TO_KPA;
    const chargeK = chargeTempK(boostPsi, mods.intercooler);
    const vCylM3 = (engineDerived.displacementL / engineDerived.cyl) / 1000;
    const airDensity = (mapKpa * 1000) / (R_AIR * chargeK);
    const airChargeG = (interp2(ve, rpm, mapKpa) / 100) * vCylM3 * airDensity * 1000;
    const lambda = interp2(afr, rpm, mapKpa) / 14.7;
    const fuelMassG = airChargeG / (lambda * fuel.stoich);
    const pw = fuelMassG / ((ecuInjectorCc * fuel.density) / 60000) + INJ_DEADTIME_MS;
    return clamp((pw / (120000 / rpm)) * 100, 0, 220);
  }, [ve, afr, turboOn, boostCurve, ecuInjectorCc, fuel, mods.intercooler, engineDerived]);

  // Which load rows this engine can physically reach. Naturally aspirated tops out
  // at atmospheric; boost walks the tables into the higher-MAP rows.
  const peakBoostPsi = turboOn ? Math.max(...boostCurve) : 0;
  const maxReachableMap = BARO_KPA + peakBoostPsi * PSI_TO_KPA;
  const visibleRows = useMemo(
    () => LOAD.map((m, i) => i).filter((i) => LOAD[i] <= maxReachableMap + 2),
    [maxReachableMap]
  );

  const needsMafRecal = mods.intake || turboOn;
  const changeTab = (t) => {
    // Browsers only allow audio to start from inside a user gesture, so take every
    // tap as an opportunity to unlock it.
    const a = audioRef.current;
    if (a && a.ctx.state === 'suspended') a.ctx.resume();
    setTab(t); setSelection(null);
  };

  const installMod = (key) => {
    if (mods[key]) return;
    if (key === 'intercooler') { setMods((m) => ({ ...m, intercooler: true })); return; }
    // Fitting a part changes airflow but does NOT edit your logged VE table — the
    // VE tab will show the gap and let you accept it once you understand why.
    setMods({ ...mods, [key]: true });
  };
  const resetToStock = () => {
    setVe(computeHardwareVE(engineConfig, DEFAULT_MODS, hwForVe));
    setTiming(clone2D(DEFAULT_TIMING)); setAfr(clone2D(DEFAULT_AFR));
    setMods(DEFAULT_MODS); setMafScalar(1.0);
  };
  const repairEngine = () => setHealth({ piston: 100, bearing: 100, valve: 100 });

  // Taking a job resets the car to stock, then applies that job's specific fault.
  const takeJob = (i) => {
    const job = CAREER_JOBS[i];
    const cfg = { ...DEFAULT_ENGINE_CONFIG };
    if (job.setup.camDuration) cfg.camDuration = job.setup.camDuration;
    if (job.setup.springRate) cfg.springRate = job.setup.springRate;
    const nextMods = { ...DEFAULT_MODS, intake: !!job.setup.intake };
    const nextTurbo = !!job.setup.turboOn;
    const hw = {
      turboOn: nextTurbo,
      turbine: nextTurbo ? TURBINE_OPTS[1] : null,
      exhaustDia: EXHAUST_DIA_OPTS[1].dia,
      fuel: OCTANE_OPTS[job.setup.octaneIdx ?? 0],
    };
    setEngineConfig(cfg);
    setMods(nextMods);
    setTurboOn(nextTurbo);
    setBoostCurve(job.setup.boostCurve ? [...job.setup.boostCurve] : [...DEFAULT_BOOST]);
    setOctaneIdx(job.setup.octaneIdx ?? 0);
    setInjIdx(job.setup.injIdx ?? 0);
    setEcuInjectorCc(job.setup.ecuInjectorCc ?? INJECTOR_OPTS[job.setup.injIdx ?? 0].cc);
    setTiming(clone2D(DEFAULT_TIMING));
    setAfr(clone2D(DEFAULT_AFR));
    setMafScalar(1.0);
    // A "stale VE" job hands you the OLD log against new hardware — the whole point.
    setVe(job.setup.staleVe
      ? computeHardwareVE(DEFAULT_ENGINE_CONFIG, DEFAULT_MODS, { turboOn: false, turbine: null, exhaustDia: EXHAUST_DIA_OPTS[1].dia, fuel: OCTANE_OPTS[0] })
      : computeHardwareVE(cfg, nextMods, hw));
    setHealth({ piston: 100, bearing: 100, valve: 100 });
    setResult(null); setPrevResult(null); setHistogram(null); setJobResult(null);
    setActiveJob(i);
    setTab('dyno');
  };
  const setCfg = (patch) => setEngineConfig((c) => ({ ...c, ...patch }));

  const ensureAudio = () => {
    if (audioRef.current) return audioRef.current;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    try {
      const ctx = new Ctx();
      // Exhaust pulses are sharp transients, so raw gain clips long before it sounds
      // loud. A limiter on the output lets the average level come up a long way
      // while the peaks stay clean — the same reason real engine recordings are
      // compressed before anyone hears them.
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -14;
      limiter.knee.value = 8;
      limiter.ratio.value = 12;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.12;
      const outGain = ctx.createGain(); outGain.gain.value = 2.4; // make-up gain
      limiter.connect(outGain); outGain.connect(ctx.destination);

      const master = ctx.createGain(); master.gain.value = 0; master.connect(limiter);

      // An exhaust note is a PULSE TRAIN, not a smooth wave — each cylinder fires a
      // sharp pressure spike. Building a periodic wave with many harmonics falling
      // off ~1/n gives that pulse character, which sounds far more like an engine
      // than a raw sawtooth does.
      // A real exhaust pulse is close to a narrow impulse, which means a LOT of
      // harmonics with only gentle roll-off. Too few harmonics and it sounds like a
      // synthesiser; enough of them and the ear hears discrete exhaust pulses.
      const N = 48;
      const re = new Float32Array(N), im = new Float32Array(N);
      for (let n = 1; n < N; n++) {
        // 1/n^0.85 keeps the upper harmonics alive; the exp term stops it being harsh.
        im[n] = Math.pow(1 / n, 0.85) * Math.exp(-n / 26);
        // slight phase scatter stops every harmonic peaking together, which is what
        // makes a pure synthetic wave sound artificial.
        re[n] = im[n] * 0.35 * Math.sin(n * 1.7);
      }
      const pulseWave = ctx.createPeriodicWave(re, im, { disableNormalization: false });

      // Two slightly detuned pulse oscillators — real engines never hold a perfectly
      // pure pitch, and the beating between them is what stops it sounding synthetic.
      const oscA = ctx.createOscillator(); oscA.setPeriodicWave(pulseWave); oscA.frequency.value = 40;
      const oscB = ctx.createOscillator(); oscB.setPeriodicWave(pulseWave); oscB.frequency.value = 40; oscB.detune.value = 9;
      const oscG = ctx.createGain(); oscG.gain.value = 0.5;
      const sub = ctx.createOscillator(); sub.type = 'sine'; sub.frequency.value = 20;
      const subG = ctx.createGain(); subG.gain.value = 0.35;

      // Exhaust system: a resonant body plus an overall lowpass.
      const body = ctx.createBiquadFilter(); body.type = 'bandpass'; body.frequency.value = 320; body.Q.value = 0.9;
      const bodyG = ctx.createGain(); bodyG.gain.value = 0.8;
      // Second resonance — a real exhaust system has several. Two peaks is enough
      // to stop it sounding like a single filtered buzz.
      const body2 = ctx.createBiquadFilter(); body2.type = 'bandpass'; body2.frequency.value = 900; body2.Q.value = 1.6;
      const body2G = ctx.createGain(); body2G.gain.value = 0.3;
      const filter = ctx.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 900; filter.Q.value = 2;
      filter.connect(master); body.connect(bodyG); bodyG.connect(master); body2.connect(body2G); body2G.connect(master);
      oscA.connect(oscG); oscB.connect(oscG); oscG.connect(filter); oscG.connect(body); oscG.connect(body2);
      sub.connect(subG); subG.connect(filter);

      const bufLen = 2 * ctx.sampleRate;
      const buf = ctx.createBuffer(1, bufLen, ctx.sampleRate);
      const dch = buf.getChannelData(0);
      for (let i = 0; i < bufLen; i++) dch[i] = (Math.random() * 2 - 1) * 0.35;

      // Combustion roughness, amplitude-modulated at the firing rate so the noise
      // arrives in pulses rather than as constant hiss.
      const noise = ctx.createBufferSource(); noise.buffer = buf; noise.loop = true;
      const ng = ctx.createGain(); ng.gain.value = 0.04;
      const pulseLfo = ctx.createOscillator(); pulseLfo.type = 'sawtooth'; pulseLfo.frequency.value = 40;
      const pulseDepth = ctx.createGain(); pulseDepth.gain.value = 0.03;
      pulseLfo.connect(pulseDepth); pulseDepth.connect(ng.gain);
      noise.connect(ng); ng.connect(filter);

      // LOPE: valve overlap makes combustion inconsistent cylinder-to-cylinder at
      // idle, so output surges and dips at a slow sub-multiple of the firing rate.
      // That uneven pulsing is the classic cammed idle.
      const lopeLfo = ctx.createOscillator(); lopeLfo.type = 'triangle'; lopeLfo.frequency.value = 6;
      const lopeDepth = ctx.createGain(); lopeDepth.gain.value = 0;
      lopeLfo.connect(lopeDepth); lopeDepth.connect(master.gain);
      lopeLfo.start();

      const indG = ctx.createGain(); indG.gain.value = 0;
      const indFilt = ctx.createBiquadFilter(); indFilt.type = 'bandpass'; indFilt.frequency.value = 1800; indFilt.Q.value = 1.2;
      const noise2 = ctx.createBufferSource(); noise2.buffer = buf; noise2.loop = true;
      noise2.connect(indFilt); indFilt.connect(indG); indG.connect(master);

      // --- TURBO ---
      // A real turbo is not a pure tone. It is a narrow band of noise from the
      // blade-pass frequency, sitting on top of a broadband rush of moving air.
      // A bare sine is the single biggest reason synthesised turbos sound fake.
      const whistle = ctx.createOscillator(); whistle.type = 'sine'; whistle.frequency.value = 3000;
      const whistleG = ctx.createGain(); whistleG.gain.value = 0;
      whistle.connect(whistleG); whistleG.connect(master);

      // Blade-pass noise: white noise squeezed through a very high-Q bandpass so it
      // "sings" at the shaft frequency without being a clean tone.
      const bladeFilt = ctx.createBiquadFilter(); bladeFilt.type = 'bandpass';
      bladeFilt.frequency.value = 3000; bladeFilt.Q.value = 9;
      const bladeG = ctx.createGain(); bladeG.gain.value = 0;
      const noiseBlade = ctx.createBufferSource(); noiseBlade.buffer = buf; noiseBlade.loop = true;
      noiseBlade.connect(bladeFilt); bladeFilt.connect(bladeG); bladeG.connect(master);

      // Compressor rush: the broadband sound of a lot of air being moved. Scales
      // with actual airflow, so it builds as the turbo comes up.
      const rushFilt = ctx.createBiquadFilter(); rushFilt.type = 'bandpass';
      rushFilt.frequency.value = 1200; rushFilt.Q.value = 0.7;
      const rushG = ctx.createGain(); rushG.gain.value = 0;
      const noiseRush = ctx.createBufferSource(); noiseRush.buffer = buf; noiseRush.loop = true;
      noiseRush.connect(rushFilt); rushFilt.connect(rushG); rushG.connect(master);

      // Blow-off: trapped boost venting. A burst of air whose pitch falls away as
      // the pressure bleeds down.
      // COMPRESSOR FLUTTER — the "stu-tu-tu-tu".
      // When the throttle shuts with the turbo still spinning, the air has nowhere to
      // go, stalls back across the compressor wheel, then surges forward again —
      // repeatedly. That cycling is a PULSATION around 20-48 Hz, not a hiss, which is
      // why it has to be amplitude-modulated air rather than filtered noise.
      const flutFilt = ctx.createBiquadFilter();
      flutFilt.type = 'bandpass'; flutFilt.frequency.value = 850; flutFilt.Q.value = 2.4;
      // Base 0.5 with a +/-0.5 square LFO makes the gate swing fully CLOSED to fully
      // OPEN. Leaving the base at 0 (as an earlier version did) lets audio through at
      // both extremes — negative gain only inverts phase — so it never pulsed at all.
      const flutGate = ctx.createGain(); flutGate.gain.value = 0.5;
      const flutEnv = ctx.createGain(); flutEnv.gain.value = 0;    // overall burst envelope
      const flutLfo = ctx.createOscillator();
      flutLfo.type = 'square'; flutLfo.frequency.value = 28;       // the tu-tu-tu rate
      const flutDepth = ctx.createGain(); flutDepth.gain.value = 0.55; // slight overdrive = harder chop
      flutLfo.connect(flutDepth); flutDepth.connect(flutGate.gain);
      const noiseFlut = ctx.createBufferSource(); noiseFlut.buffer = buf; noiseFlut.loop = true;
      noiseFlut.connect(flutFilt); flutFilt.connect(flutGate); flutGate.connect(flutEnv);
      flutEnv.connect(outGain);                                    // bypass the limiter
      flutLfo.start(); noiseFlut.start();

      // SHIFT CLUNK. A gear change is mechanical: dogs or synchros engaging make a
      // short, low, woody knock. Without it a shift is just a dip in volume, which
      // reads as a glitch rather than as a gearchange.
      // TORQUE CONVERTER. A slipping converter has a distinctive fluid whine that
      // rises as slip increases — loudest off the line where the engine is spinning
      // far faster than the gearbox input, and fading away as it couples up. A
      // manual has nothing equivalent, which is a large part of why the two sound
      // so different from a standstill.
      const convOsc = ctx.createOscillator(); convOsc.type = 'triangle'; convOsc.frequency.value = 320;
      const convG = ctx.createGain(); convG.gain.value = 0;
      const convFilt = ctx.createBiquadFilter();
      convFilt.type = 'bandpass'; convFilt.frequency.value = 500; convFilt.Q.value = 2.0;
      convOsc.connect(convFilt); convFilt.connect(convG); convG.connect(master);
      convOsc.start();

      const clunkFilt = ctx.createBiquadFilter();
      clunkFilt.type = 'bandpass'; clunkFilt.frequency.value = 190; clunkFilt.Q.value = 3.5;
      const clunkG = ctx.createGain(); clunkG.gain.value = 0;
      const noiseClunk = ctx.createBufferSource(); noiseClunk.buffer = buf; noiseClunk.loop = true;
      noiseClunk.connect(clunkFilt); clunkFilt.connect(clunkG); clunkG.connect(outGain);
      noiseClunk.start();

      const bovFilt = ctx.createBiquadFilter(); bovFilt.type = 'bandpass'; bovFilt.frequency.value = 1500; bovFilt.Q.value = 0.9;
      const bovG = ctx.createGain(); bovG.gain.value = 0;
      const noise3 = ctx.createBufferSource(); noise3.buffer = buf; noise3.loop = true;
      // The blow-off goes STRAIGHT to the output, bypassing the limiter. Routed
      // through master it was being ducked by the very compression that makes the
      // engine note loud, so it never cut through — which is why it was inaudible.
      noise3.connect(bovFilt); bovFilt.connect(bovG); bovG.connect(outGain);
      noiseBlade.start(); noiseRush.start();

      // ================= EXHAUST PULSE ENGINE =================
      // Engine character does not come from a waveform — it comes from a train of
      // discrete exhaust pulses and, crucially, HOW EVENLY THEY ARE SPACED.
      //   * A cross-plane V8 fires unevenly within each bank. That irregular
      //     spacing IS the rumble. Even-firing it and it stops sounding like a V8.
      //   * A 60/120-degree V6 fires evenly and smoothly — a hard, hornlike note.
      //   * An inline four fires only twice per revolution, so the pulses are far
      //     apart and individually audible: the classic buzzy, hollow four.
      // So we schedule individual pulses instead of running an oscillator.
      // Real combustion events are never identical, so one reused pulse sample reads
      // as synthetic no matter how it is filtered. Build several variants and pick
      // between them at random.
      const pulseVariants = [];
      for (let v = 0; v < 6; v++) {
        const pLen = Math.floor(ctx.sampleRate * 0.13);
        const pb = ctx.createBuffer(1, pLen, ctx.sampleRate);
        const pd = pb.getChannelData(0);
        const decay = 30 + v * 9;               // 0-2 linger (soft), 3-5 snap (sharp)
        const thumpHz = 62 + v * 9;             // pressure-wave pitch
        const crackAmt = 0.16 + v * 0.11;       // low variants are thuddier
        for (let i = 0; i < pLen; i++) {
          const x = i / ctx.sampleRate;
          const env = Math.exp(-x * decay);
          const attack = Math.min(1, x / (v < 3 ? 0.0035 : 0.0010)); // soft variants open gently
          const thump = Math.sin(2 * Math.PI * thumpHz * x) * 0.9;
          const crack = (Math.random() * 2 - 1) * crackAmt;
          pd[i] = (thump + crack) * env * attack;
        }
        pulseVariants.push(pb);
      }

      // PRE-RENDERED PULSE TRAIN (high RPM).
      // Scheduling one node per firing event costs too much above ~200 events/sec,
      // but switching to oscillators up there just sounds like a synthesiser —
      // because it is one. The right answer is to keep real exhaust pulses and make
      // them cheap: pre-render several complete engine cycles, WITH this layout's
      // firing pattern baked in, then loop that buffer and vary its playback rate
      // with RPM. One node total, the firing order survives, and the cross-plane V8
      // still rumbles at redline because the uneven spacing is inside the sample.
      const LOOP_REF_RPM = 3000;
      const LOOP_VARIANTS = 2;  // each one is an always-running source; keep it lean
      const loopSources = {};   // loopSources[cyl] = [src, src, src]
      const loopGains = {};
      [4, 6, 8].forEach((nCyl) => {
        const pattern = nCyl === 8
          ? [0.72, 1.28, 0.72, 1.28, 0.72, 1.28, 0.72, 1.28]
          : new Array(nCyl).fill(1);
        const cycleSec = 120 / LOOP_REF_RPM;
        const len = Math.round(ctx.sampleRate * cycleSec);
        loopSources[nCyl] = []; loopGains[nCyl] = [];

        // THREE variants, each ONE engine cycle long and each internally periodic.
        //
        // The balance being struck here: any variation baked INSIDE a loop repeats at
        // the loop rate and is heard as a woosh. But a single perfectly periodic loop
        // is a pure repeating waveform — which is to say, a synthesiser. Real engines
        // vary cycle to cycle without any fixed period.
        //
        // So each buffer stays perfectly periodic, and variation comes from slowly
        // crossfading BETWEEN the variants at random intervals. The variation rate is
        // then completely decoupled from the loop rate, so it cannot beat.
        for (let vIdx = 0; vIdx < LOOP_VARIANTS; vIdx++) {
          const lb = ctx.createBuffer(1, len, ctx.sampleRate);
          const ld = lb.getChannelData(0);
          const gap = cycleSec / nCyl;
          const decay = 40 + vIdx * 7;
          const thumpHz = 70 + vIdx * 11;
          const crackAmt = 0.24 + vIdx * 0.07;
          let seed = 12345 + vIdx * 7919;
          const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
          for (let ev = 0; ev < nCyl; ev++) {
            let tPos = 0;
            for (let k = 0; k < ev; k++) tPos += gap * pattern[k % pattern.length];
            const st = Math.floor(tPos * ctx.sampleRate);
            const evLen = Math.floor(ctx.sampleRate * 0.09);
            for (let i = 0; i < evLen; i++) {
              const j = (st + i) % len;               // wrap, so the loop point is seamless
              const x = i / ctx.sampleRate;
              const env = Math.exp(-x * decay);
              const attack = Math.min(1, x / 0.0012);
              ld[j] += (Math.sin(2 * Math.PI * thumpHz * x) * 0.9
                        + (rnd() * 2 - 1) * crackAmt) * env * attack;
            }
          }
          const srcL = ctx.createBufferSource();
          srcL.buffer = lb; srcL.loop = true;
          const gL = ctx.createGain(); gL.gain.value = 0;
          srcL.connect(gL);
          loopSources[nCyl].push(srcL); loopGains[nCyl].push(gL);
        }
      });

      // EXHAUST WAVEGUIDE. A pipe is a resonant tube: each pressure pulse travels
      // down it, reflects off the open end, and returns. A short delay with feedback
      // reproduces that directly, and it is the biggest single difference between
      // "filtered buzz" and something that sounds like an actual exhaust system.
      // Delay time sets the pipe's fundamental: f = 1 / (2 x delay).
      const pipeDelay = ctx.createDelay(0.05);
      pipeDelay.delayTime.value = 0.0116;       // ~86 Hz, roughly a 2 m system
      const pipeFb = ctx.createGain(); pipeFb.gain.value = 0.55;
      const pipeDamp = ctx.createBiquadFilter();
      pipeDamp.type = 'lowpass'; pipeDamp.frequency.value = 1800; // pipes lose highs
      pipeDelay.connect(pipeDamp); pipeDamp.connect(pipeFb); pipeFb.connect(pipeDelay);
      const pipeOut = ctx.createGain(); pipeOut.gain.value = 0.9;
      pipeDamp.connect(pipeOut); pipeOut.connect(master);

      const pulseBus = ctx.createGain(); pulseBus.gain.value = 2.3;
      // Only the starting layout is connected; the effect swaps them as needed.
      loopGains[6].forEach((g) => g.connect(pulseBus));
      const loopConnected = { 4: false, 6: true, 8: false };
      pulseBus.connect(filter); pulseBus.connect(body); pulseBus.connect(body2);
      pulseBus.connect(pipeDelay);

      [4, 6, 8].forEach((n) => loopSources[n].forEach((src) => { try { src.start(); } catch { /* already started */ } }));
      oscA.start(); oscB.start(); sub.start(); noise.start(); noise2.start(); noise3.start(); pulseLfo.start();
      audioRef.current = { ctx, oscA, oscB, oscG, sub, subG, master, filter, body, bodyG, body2, body2G, ng, pulseLfo, lopeLfo, lopeDepth, indG, whistle, whistleG, bladeFilt, bladeG, rushFilt, rushG, bovFilt, bovG, clunkFilt, clunkG, convOsc, convG, convFilt, flutFilt, flutGate, flutEnv, flutLfo, limiter, outGain,
        pulseVariants, pulseBus, pipeDelay, pipeFb, pipeDamp, pipeOut,
        loopSources, loopGains, loopConnected, LOOP_REF_RPM, LOOP_VARIANTS,
        loopBlend: [1, 0], loopNextSwap: 0, nextPulse: 0, pulseIdx: 0 };
      return audioRef.current;
    } catch { return null; }
  };

  // Firing-interval patterns, as multiples of the average gap between cylinders.
  // These are what make each layout recognisable before any filtering is applied.
  const FIRING_PATTERN = {
    4: [1, 1, 1, 1],                        // inline four: even, widely spaced
    6: [1, 1, 1, 1, 1, 1],                  // 60/120 V6: even and smooth
    8: [0.72, 1.28, 0.72, 1.28, 0.72, 1.28, 0.72, 1.28], // cross-plane V8: uneven = rumble
  };

  // Schedules exhaust pulses slightly ahead of real time. Called from the same
  // 20 Hz loop that runs the engine, so it stays in step with RPM.
  const schedulePulses = (rpm, level, cyl, dispL, overlapDeg = 0) => {
    const a = audioRef.current;
    if (!a || !soundOn || rpm < 200 || level <= 0.001) return;
    const now = a.ctx.currentTime;
    if (a.nextPulse < now) a.nextPulse = now + 0.02;

    // One full engine cycle is two crank revolutions; each cylinder fires once.
    const cycleSec = 120 / Math.max(rpm, 200);
    const avgGap = cycleSec / cyl;
    const pattern = FIRING_PATTERN[cyl] || [1];

    // Bigger engines make longer, lower-pitched pulses.
    const rate = clamp(1.35 - (dispL - 2.0) * 0.14, 0.55, 1.5);

    // Below about 90 events/sec the ear resolves individual exhaust pulses — that is
    // where rumble, lope and firing order live, so the pulse train does the work.
    // Above roughly 200/sec the ear fuses them into a continuous tone and discrete
    // samples stop helping; playing sparse LOUD pulses up there (which an earlier
    // version did to save CPU) sounds like hitting a tin can, because that is
    // literally what it is. So the pulse train fades out across that transition and
    // the continuous layer takes over — which is also what keeps node allocation
    // bounded. Crossfade, never decimate.
    const pulsesPerSec = 1 / avgGap;
    const pulseMix = clamp(1 - (pulsesPerSec - 90) / 110, 0, 1);
    if (pulseMix <= 0.02) { a.nextPulse = now + 0.02; return; }
    const strideGain = 1;

    let guard = 0;
    while (a.nextPulse < now + 0.14 && guard++ < 40) {
      {
        const src = a.ctx.createBufferSource();
        // Variants 0-2 are softer (slower decay, less crack); 3-5 are sharper.
        // At low load pick from the soft end — an idling cylinder vents a dull thud,
        // not the hard crack you get at full throttle.
        const soft = level < 0.35;
        const pick = soft
          ? (Math.random() * 3) | 0
          : 3 + ((Math.random() * 3) | 0);
        src.buffer = a.pulseVariants[pick];
        // Slight per-pulse variation — no two combustion events are identical, and
        // perfectly identical pulses are what make synthesis sound mechanical.
        src.playbackRate.value = rate * (0.97 + Math.random() * 0.06);
        const g = a.ctx.createGain();
        // LOPE. Valve overlap lets exhaust back into the intake at low speed, so
        // some cycles get a diluted charge and burn weakly. Modulating individual
        // combustion events is what "lumpy idle" actually is — modulating the whole
        // mix (as this previously did) is nearly inaudible by comparison.
        let lopeMul = 1;
        if (overlapDeg > 1.5 && rpm < 2400) {
          const severity = Math.min(0.85, overlapDeg * 0.028) * clamp(1 - (rpm - 800) / 1800, 0.2, 1);
          // A slow, irregular wander so it loafs rather than buzzing.
          const wander = 0.5 + 0.5 * Math.sin(a.pulseIdx * 0.55) * Math.sin(a.pulseIdx * 0.17);
          const misfire = Math.random() < severity * 0.30 ? 0.25 : 1;
          lopeMul = (1 - severity * wander * 0.75) * misfire;
        }
        g.gain.value = level * pulseMix * lopeMul * (0.85 + Math.random() * 0.3);
        src.connect(g); g.connect(a.pulseBus);
        try { src.start(a.nextPulse); } catch { /* scheduling raced, skip */ }
        // Release the nodes as soon as they have played so they can be collected.
        src.onended = () => { try { src.disconnect(); g.disconnect(); } catch { /* already gone */ } };
      }
      a.nextPulse += avgGap * pattern[a.pulseIdx % pattern.length];
      a.pulseIdx++;
    }
  };

  // Build a wheel-torque lookup (newton-metres) from the most recent dyno pull.
  // The drag run cannot happen without a pull, because there is no torque curve
  // until the engine has actually been measured — same as real life.
  const torqueCurveNm = useMemo(() => {
    if (!result) return null;
    return (rpm) => {
      const pts = result.points;
      if (rpm <= pts[0].rpm) return pts[0].torque / 0.7376;
      if (rpm >= pts[pts.length - 1].rpm) return pts[pts.length - 1].torque / 0.7376;
      for (let i = 0; i < pts.length - 1; i++) {
        if (rpm >= pts[i].rpm && rpm <= pts[i + 1].rpm) {
          const f = (rpm - pts[i].rpm) / (pts[i + 1].rpm - pts[i].rpm);
          return (pts[i].torque + (pts[i + 1].torque - pts[i].torque) * f) / 0.7376;
        }
      }
      return pts[0].torque / 0.7376;
    };
  }, [result]);

  const runDrag = () => {
    if (!torqueCurveNm) return;
    const a = ensureAudio();
    if (a && a.ctx.state === 'suspended') a.ctx.resume();
    const res = simulateDragRun({ car, torqueCurveNm, redline: 7500, peakHp: result.peakHp });
    setDragResult(res);
    setDragT(0);

    // Christmas tree: stage, three ambers at 0.5 s intervals, then green.
    const beep = (freq, dur, vol) => {
      const au = audioRef.current;
      if (!au || !soundOn) return;
      const t0b = au.ctx.currentTime;
      const o = au.ctx.createOscillator(); o.type = 'sine'; o.frequency.value = freq;
      const g = au.ctx.createGain(); g.gain.value = 0;
      o.connect(g); g.connect(au.outGain);
      g.gain.setValueAtTime(0.0001, t0b);
      g.gain.exponentialRampToValueAtTime(vol, t0b + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0b + dur);
      o.start(t0b); o.stop(t0b + dur + 0.05);
    };

    setTreePhase(1);
    const seq = [
      [400, () => { setTreePhase(2); beep(660, 0.18, 0.30); }],
      [900, () => { setTreePhase(3); beep(660, 0.18, 0.30); }],
      [1400, () => { setTreePhase(4); beep(660, 0.18, 0.30); }],
      [1900, () => { setTreePhase(5); beep(990, 0.35, 0.40); }],
    ];
    seq.forEach(([ms, fn]) => setTimeout(fn, ms));

    setTimeout(() => {
      setDragRunning(true);
      const t0 = Date.now();
      clearInterval(dragTimer.current);
      dragTimer.current = setInterval(() => {
        const el = (Date.now() - t0) / 1000;
        setDragT(el);
        if (el > res.et + 1.2) {
          clearInterval(dragTimer.current);
          setDragRunning(false);
          setTreePhase(0);
        }
      }, 40);
    }, 1900);
  };
  useEffect(() => () => clearInterval(dragTimer.current), []);

  const persistCareer = async (best, total, pulls) => {
    try { await window.storage.set('career', JSON.stringify({ best, total, pulls })); } catch { /* best-effort */ }
  };

  const doRun = () => {
    const a = ensureAudio();
    if (a && a.ctx.state === 'suspended') a.ctx.resume();
    setRunning(true);
    setRevealCount(0);
    const r = simulateSweep({
      loadKpa, ve, veTrueTable, timing, afr, turboOn, boostCurve, octaneBonus, octaneLabel: OCTANE_OPTS[octaneIdx].label,
      fuel, injectorCc, ecuInjectorCc, injectorLabel: INJECTOR_OPTS[injIdx].label, mods, mafScalar, derived: engineDerived,
      turbine: TURBINE_OPTS[turbineIdx], compressor: COMPRESSOR_OPTS[compressorIdx], exhaustDiaError,
    });
    setPrevResult(result);
    setResult(r);
    setHealth((h) => ({
      piston: clamp(h.piston - r.wear.piston, 0, 100),
      bearing: clamp(h.bearing - r.wear.bearing, 0, 100),
      valve: clamp(h.valve - r.wear.valve, 0, 100),
    }));
    const ts = computeTuningScore(r);
    const es = computeEngineerScore({
      engineConfig, turboOn, turbine: TURBINE_OPTS[turbineIdx], compressor: COMPRESSOR_OPTS[compressorIdx],
      exhaustDiaError, dutyPreview, displacementL: engineDerived.displacementL,
    });
    const pull = computePullScore({ peakHp: r.peakHp, peakTq: r.peakTq, tuningScore: ts.score, engineerScore: es.score });
    if (mode === 'career' && activeJob != null) {
      const passed = CAREER_JOBS[activeJob].goal(r, { tuningScore: ts.score, engineerScore: es.score });
      setJobResult(passed ? 'pass' : 'fail');
      if (passed && !completedJobs.includes(activeJob)) setCompletedJobs((c) => [...c, activeJob]);
    }
    const nextBest = Math.max(bestScore, pull);
    const nextTotal = totalScore + pull;
    const nextPulls = pullCount + 1;
    setBestScore(nextBest); setTotalScore(nextTotal); setPullCount(nextPulls);
    persistCareer(nextBest, nextTotal, nextPulls);
    // ---- Pull sequence -----------------------------------------------------
    // settle    hold idle so you can hear it running before it is loaded
    // sweep     load it and take it to redline, drawing the graph
    // spooldown throttle shut, revs fall back on engine braking
    // rest      settle at idle again, then the pull is over
    const total = r.points.length;
    const SETTLE_MS = 1400, SWEEP_MS = 1900, DOWN_MS = 2100, REST_MS = 900;
    const idleRpm = 820;
    const topRpm = r.points[total - 1].rpm;
    const t0 = Date.now();
    setDynoPhase('settle');
    setDynoRpm(idleRpm);
    setRevealCount(0);

    revealTimer.current = setInterval(() => {
      const el = Date.now() - t0;
      if (el < SETTLE_MS) {
        setDynoPhase('settle');
        setDynoRpm(idleRpm + Math.sin(el / 90) * 14);
      } else if (el < SETTLE_MS + SWEEP_MS) {
        const f = (el - SETTLE_MS) / SWEEP_MS;
        const idx = Math.min(total, Math.round(f * total));
        setDynoPhase('sweep');
        setRevealCount(idx);
        setDynoRpm(r.points[Math.min(total - 1, Math.max(0, idx - 1))].rpm);
      } else if (el < SETTLE_MS + SWEEP_MS + DOWN_MS) {
        // Engine braking: fast at first, easing as friction and pumping losses
        // fall away with RPM.
        const f = (el - SETTLE_MS - SWEEP_MS) / DOWN_MS;
        setDynoPhase('spooldown');
        setRevealCount(total);
        setDynoRpm(idleRpm + (topRpm - idleRpm) * Math.pow(1 - f, 2.2));
      } else if (el < SETTLE_MS + SWEEP_MS + DOWN_MS + REST_MS) {
        setDynoPhase('rest');
        setDynoRpm(idleRpm + Math.sin(el / 90) * 12);
      } else {
        clearInterval(revealTimer.current);
        setDynoPhase(null);
        setRunning(false);
      }
    }, 55);
  };
  useEffect(() => () => { if (revealTimer.current) clearInterval(revealTimer.current); }, []);

  // Keep the live-engine config in a ref so the loop always uses current tuning
  // without needing to restart the interval every time a table changes.
  liveCfgRef.current = {
    ve, veTrueTable, timing, afr, derived: engineDerived, fuel, injectorCc, ecuInjectorCc, mods, mafScalar, mafErrorBase,
    turboOn, boostCurve, octaneBonus, turbine: TURBINE_OPTS[turbineIdx],
    compressor: COMPRESSOR_OPTS[compressorIdx], exhaustDiaError,
  };
  throttleRef.current = throttleInput;
  tabRef.current = tab;
  cylRef.current = engineDerived.cyl;
  dispRef.current = engineDerived.displacementL;
  overlapRef.current = engineDerived.overlapDeg || 0;

  // The engine runs continuously in the background at 20 Hz, integrating real
  // crankshaft dynamics and running one ECU control pass per step.
  useEffect(() => {
    liveTimer.current = setInterval(() => {
      // The physics steps at 20 Hz, but re-rendering the whole component 20 times a
      // second makes the UI drop taps — which is why buttons needed pressing twice.
      // So the authoritative engine state lives in a ref (no re-render), and React
      // state is updated only ~7 times a second, purely for the gauges.
      const prev = liveRef.current;
      if (prev.running || prev.cranking || prev.rpm > 1) {
        liveRef.current = liveStep(prev, 0.05, { throttle: throttleRef.current, load: 0 }, liveCfgRef.current);
      }
      const nx = liveRef.current;

      // Audio is driven from the ref so it stays smooth regardless of render rate.
      if (tabRef.current === 'live' && (nx.running || nx.cranking)) {
        const lvl = nx.fuelCut ? 0.14 : 0.42 + clamp((nx.effThrottle ?? 0) / 100, 0, 1) * 0.62;
        schedulePulses(nx.rpm, lvl, cylRef.current, dispRef.current, overlapRef.current);
      }

      uiTickRef.current += 1;
      if (uiTickRef.current % 3 === 0) setLive(nx);
    }, 50);
    return () => clearInterval(liveTimer.current);
  }, []);

  // ---- Engine audio -------------------------------------------------------
  // Synthesised from the firing frequency: a 4-stroke fires cyl/2 times per
  // crank revolution, so pitch tracks RPM and cylinder count exactly. A lowpass
  // that opens with throttle gives the "load" character — closed throttle is
  // muffled, wide open is bright and raspy.
  // A deliberately obvious beep. If this is silent, the problem is the device or the
  // browser (on iPhone the ring/silent switch mutes web audio), not the engine model.
  const testSound = () => {
    const a = ensureAudio();
    if (!a) { setAudioStatus('unavailable'); return; }
    a.ctx.resume();
    const t0 = a.ctx.currentTime;
    const o = a.ctx.createOscillator(); o.type = 'square'; o.frequency.value = 220;
    const g = a.ctx.createGain(); g.gain.value = 0;
    o.connect(g); g.connect(a.ctx.destination);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.35, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.45);
    o.start(t0); o.stop(t0 + 0.5);
    setAudioStatus(a.ctx.state === 'running' ? 'ok' : 'blocked');
  };

  const startEngine = () => {
    const a = ensureAudio();
    if (a && a.ctx.state === 'suspended') a.ctx.resume();
    liveRef.current = { ...liveRef.current, cranking: true };
    setLive(liveRef.current);
  };
  const stopEngine = () => {
    setThrottleInput(0); throttleRef.current = 0;
    liveRef.current = { ...liveRef.current, running: false, cranking: false };
    setLive(liveRef.current);
  };

  // Safety net: if a pointerup/cancel is missed (scroll, app switch, lost focus)
  // the throttle must still close, or the engine would hang at redline.
  useEffect(() => {
    const release = () => { setThrottleInput(0); throttleRef.current = 0; };
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    window.addEventListener('blur', release);
    document.addEventListener('visibilitychange', release);
    return () => {
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
      window.removeEventListener('blur', release);
      document.removeEventListener('visibilitychange', release);
    };
  }, []);

  // Career stats persist across sessions so the high score is worth chasing.
  useEffect(() => {
    (async () => {
      try {
        const res = await window.storage.get('career');
        if (res?.value) {
          const c = JSON.parse(res.value);
          setBestScore(c.best ?? 0); setTotalScore(c.total ?? 0); setPullCount(c.pulls ?? 0);
        }
      } catch { /* no saved career yet — start fresh */ }
    })();
  }, []);

  const chartData = useMemo(() => {
    if (!result) return [];
    return result.points.slice(0, running ? revealCount : result.points.length).map((p, i) => ({
      rpm: p.rpm, hp: p.hp, torque: p.torque, afr: p.afr, afrCommanded: p.afrCommanded,
      timing: p.timing, commandedTiming: p.commandedTiming, duty: p.duty, trimPct: p.trimPct,
      prevHp: prevResult?.points?.[i]?.hp, prevTorque: prevResult?.points?.[i]?.torque,
    }));
  }, [result, prevResult, running, revealCount]);

  // HISTOGRAM — the core real-world tuning workflow. A pull's lambda error is
  // binned onto the same RPM x MAP grid as the VE table, so the correction can be
  // applied cell-for-cell. This is what HP Tuners' scanner histogram does.
  const buildHistogram = () => {
    if (!result) return;
    const cells = LOAD.map(() => RPM.map(() => ({ sum: 0, n: 0 })));
    result.points.forEach((p) => {
      let ri = 0, best = Infinity;
      LOAD.forEach((m, i) => { const d = Math.abs(m - p.map); if (d < best) { best = d; ri = i; } });
      let ci = 0, bc = Infinity;
      RPM.forEach((r, i) => { const d = Math.abs(r - p.rpm); if (d < bc) { bc = d; ci = i; } });
      // error % = how far actual lambda sat from commanded
      // Standard VE correction. If the engine ran LEANER than commanded there was
      // more air present than the table claimed, so VE must rise by that ratio:
      //     newVE = oldVE x (measuredAFR / commandedAFR)
      // Running rich gives a negative number and VE comes down. This is the same
      // arithmetic professional scanners apply to a logged histogram.
      const err = ((p.afr / p.afrCommanded) - 1) * 100;
      cells[ri][ci].sum += err; cells[ri][ci].n += 1;
    });
    setHistogram(cells.map((row) => row.map((c) => (c.n ? c.sum / c.n : null))));
  };
  const applyHistogram = () => {
    if (!histogram) return;
    setVe((prev) => prev.map((row, ri) => row.map((v, ci) => {
      const e = histogram[ri][ci];
      return e == null ? v : Number(clamp(v * (1 + e / 100), 10, 130).toFixed(1));
    })));
    setHistogram(null);
  };

  const currentRpm = running
    ? dynoRpm
    : (result ? (result.points[Math.min(revealCount, result.points.length - 1)]?.rpm ?? 1500) : 1500);
  const scores = useMemo(() => {
    if (!result || running) return null;
    const tuning = computeTuningScore(result);
    const engineer = computeEngineerScore({
      engineConfig, turboOn, turbine: TURBINE_OPTS[turbineIdx], compressor: COMPRESSOR_OPTS[compressorIdx],
      exhaustDiaError, dutyPreview, displacementL: engineDerived.displacementL,
    });
    const pull = computePullScore({ peakHp: result.peakHp, peakTq: result.peakTq, tuningScore: tuning.score, engineerScore: engineer.score });
    return { tuning, engineer, pull };
  }, [result, running, engineConfig, turboOn, turbineIdx, compressorIdx, exhaustDiaError, dutyPreview, engineDerived]);

  // Drive the audio from whichever engine is actually turning — and only while the
  // relevant page is open, so sound stops the moment you navigate away.
  const prevBoostRef = useRef(0);
  const wasRunningRef = useRef(false);
  const audioThrottleRef = useRef(0);
  const lastGearRef = useRef(1);
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const t = a.ctx.currentTime;

    // Throttle the heavy parameter updates to ~12 Hz. The engine loop runs at 20 Hz
    // and every run wrote ~25 audio parameters; that is pure overhead on a phone.
    // Pulse scheduling below still runs every tick so timing stays exact.
    const nowMs = Date.now();
    const paramsDue = nowMs - (audioThrottleRef.current || 0) > 80;
    if (paramsDue) audioThrottleRef.current = nowMs;

    const onDyno = tab === 'dyno' && running && result;
    // The drag run drives the same engine sound — RPM sweeps within each gear and
    // drops on every shift, so you hear the whole pass.
    const onDrag = tab === 'drag' && dragRunning && dragResult;
    const dragPt = onDrag
      ? (dragResult.trace.find((p) => p.t >= dragT) || dragResult.trace[dragResult.trace.length - 1])
      : null;
    const onLive = tab === 'live' && (live.running || live.cranking);
    const audible = onDyno || onLive || onDrag;

    const rpm = onDrag ? (dragPt?.rpm ?? 1000) : onDyno ? currentRpm : live.rpm;
    const dynoPt = onDyno ? result.points[Math.min(revealCount, result.points.length - 1)] : null;
    const load = onDrag
      ? 1
      : onDyno
        ? (dynoPhase === 'sweep' ? 1 : dynoPhase === 'spooldown' ? 0.04 : 0.10)
        : clamp((live.effThrottle ?? 0) / 100, 0, 1);
    const boostNow = onDyno ? (dynoPhase === 'sweep' ? (dynoPt?.boostPsi ?? 0) : 0) : (live.live?.boostPsi ?? 0);
    const cut = onLive ? live.fuelCut : (onDyno && dynoPhase === 'spooldown');

    const cyl = engineDerived.cyl;

    if (paramsDue) {
      const fire = Math.max(6, (rpm / 60) * (cyl / 2));
      a.oscA.frequency.setTargetAtTime(fire, t, 0.02);
      a.oscB.frequency.setTargetAtTime(fire, t, 0.02);
      a.sub.frequency.setTargetAtTime(fire / 2, t, 0.02);
      a.pulseLfo.frequency.setTargetAtTime(fire, t, 0.02);

      // Layout character. A four is rough and buzzy (wider detune, more upper content);
      // a V8 leans on its low-order rumble; a six sits between.
      const isFour = cyl === 4, isEight = cyl === 8;
      // The pulse train now carries the character, so the oscillators drop back to a
      // quiet underlay. Leaving them loud is what made it sound like a synthesiser.
      a.oscB.detune.setTargetAtTime(isFour ? 16 : isEight ? 6 : 9, t, 0.2);
      // High-RPM layer: the pre-rendered pulse train, pitched by RPM. These are the
      // SAME exhaust pulses in the same firing order as the discrete scheduler —
      // just rendered ahead of time so the top end costs one node instead of five
      // hundred. Nothing switches to a synthesised waveform.
      const firingRate = (rpm / 120) * cyl;
      const contMix = clamp((firingRate - 90) / 110, 0, 1);

      // Wander between the loop variants at irregular intervals. This is what stops
      // the top end sounding like a held synth note: the timbre keeps shifting, and
      // because the swap interval is random it never lines up with the loop period.
      const nowSec = a.ctx.currentTime;
      if (nowSec > a.loopNextSwap) {
        const target = (Math.random() * a.LOOP_VARIANTS) | 0;
        a.loopBlend = a.loopBlend.map((_, k) => (k === target ? 1 : 0.2 + Math.random() * 0.25));
        a.loopNextSwap = nowSec + 0.25 + Math.random() * 0.55;
      }

      // A real engine's speed micro-fluctuates from combustion variation, so the
      // pitch is never perfectly steady. A dead-steady pitch is a giveaway for
      // synthesis, so a small drift is applied here.
      const drift = 1 + (Math.random() - 0.5) * 0.006;

      [4, 6, 8].forEach((n) => {
        const active = n === cyl;
        // A gain of 0 does NOT stop Web Audio processing the node. With three
        // cylinder counts x variants all running, that was real wasted CPU on a
        // phone — so inactive layouts are disconnected outright.
        if (a.loopConnected[n] !== active) {
          a.loopGains[n].forEach((gN) => {
            try { if (active) gN.connect(a.pulseBus); else gN.disconnect(); } catch { /* noop */ }
          });
          a.loopConnected[n] = active;
        }
        if (!active) return;
        a.loopGains[n].forEach((gN, k) => {
          if (active) {
            a.loopSources[n][k].playbackRate.setTargetAtTime(
              clamp((rpm / a.LOOP_REF_RPM) * drift * (1 + (k - 1) * 0.0015), 0.2, 3.2), t, 0.05);
          }
          const share = a.loopBlend[k] / a.loopBlend.reduce((x, y) => x + y, 0);
          gN.gain.setTargetAtTime(
            active && audible ? contMix * (0.62 + load * 0.55) * share : 0, t, 0.18);
        });
      });

      // The oscillators stay a faint underlay at all speeds — they add body, they do
      // not carry the sound. Letting them take over at high RPM is what made it sound
      // like a synthesiser.
      a.oscG.gain.setTargetAtTime(isFour ? 0.045 : isEight ? 0.025 : 0.035, t, 0.1);
      a.subG.gain.setTargetAtTime((isFour ? 0.05 : isEight ? 0.16 : 0.08) + contMix * (isEight ? 0.10 : 0.05), t, 0.1);
      a.body.frequency.setTargetAtTime((isEight ? 240 : isFour ? 420 : 320) / clamp(3.5 / Math.max(engineDerived.displacementL, 1.2), 0.6, 1.6), t, 0.15);

      // --- Everything the player builds or tunes should be audible ---
      // DISPLACEMENT: a bigger engine moves more gas per pulse, so the resonant body
      // of the exhaust sits lower and the note is deeper.
      const dispL = engineDerived.displacementL;
      const dispDepth = clamp(3.5 / Math.max(dispL, 1.2), 0.6, 1.6);

      // EXHAUST DIAMETER: a bigger pipe is louder, deeper and less restricted.
      const dia = EXHAUST_DIA_OPTS[exhaustDiaIdx].dia;
      const diaOpen = 0.72 + (dia - 2.5) * 0.20;
      const catBack = mods.exhaust || mods.headers;

      // TIMING RETARD: burning later dumps more energy into the exhaust, which is why
      // a retarded engine sounds harder and raspier (and runs hotter).
      // GEAR SHIFT. On a change the clutch is out and the throttle shut, so the note
    // drops away for a moment then catches again in the next ratio — the audible
    // signature of a shift.
    if (onDrag && dragPt && dragPt.gear !== lastGearRef.current) {
      lastGearRef.current = dragPt.gear;
      if (soundOn && a.master) {
        const isAuto = GEARBOX_OPTS[car.boxIdx].label === 'Automatic';
        const back = a.master.gain.value > 0.05 ? a.master.gain.value : 0.7;
        a.master.gain.cancelScheduledValues(t);
        a.master.gain.setValueAtTime(a.master.gain.value, t);

        if (isAuto) {
          // AUTOMATIC. A torque converter is a fluid coupling — it never fully
          // disconnects, so the engine is still driving the car all the way through
          // the change. You get a soft dip and a swell as the clutches take up,
          // not a gap, and there is no mechanical engagement noise to hear.
          a.master.gain.linearRampToValueAtTime(back * 0.62, t + 0.05);  // slips, does not release
          a.master.gain.linearRampToValueAtTime(back * 1.06, t + 0.15);  // clutch packs take up
          a.master.gain.linearRampToValueAtTime(back, t + 0.26);
          if (a.clunkG) {
            // A very soft, low swell rather than a knock — the shift you feel more
            // than hear.
            a.clunkG.gain.cancelScheduledValues(t);
            a.clunkG.gain.setValueAtTime(0.0001, t + 0.03);
            a.clunkG.gain.linearRampToValueAtTime(0.13, t + 0.09);
            a.clunkG.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
            a.clunkFilt.frequency.cancelScheduledValues(t);
            a.clunkFilt.frequency.setValueAtTime(120, t + 0.03);
            a.clunkFilt.Q.setValueAtTime(1.2, t + 0.03);
          }
        } else {
          // MANUAL. The clutch fully disconnects the engine, so the note genuinely
          // falls away to nothing, the dogs engage with a hard mechanical knock, and
          // it catches again when the clutch comes back out.
          a.master.gain.linearRampToValueAtTime(0.03, t + 0.045);        // clutch in
          a.master.gain.setValueAtTime(0.03, t + 0.13);                  // gap while shifting
          a.master.gain.linearRampToValueAtTime(back * 1.12, t + 0.20);  // clutch out, flare
          a.master.gain.linearRampToValueAtTime(back, t + 0.30);
          if (a.clunkG) {
            a.clunkG.gain.cancelScheduledValues(t);
            a.clunkG.gain.setValueAtTime(0.0001, t + 0.10);
            a.clunkG.gain.linearRampToValueAtTime(0.55, t + 0.118);
            a.clunkG.gain.exponentialRampToValueAtTime(0.0001, t + 0.20);
            a.clunkFilt.frequency.cancelScheduledValues(t);
            a.clunkFilt.Q.setValueAtTime(3.5, t + 0.10);
            a.clunkFilt.frequency.setValueAtTime(240, t + 0.10);
            a.clunkFilt.frequency.exponentialRampToValueAtTime(140, t + 0.20);
          }
        }
      }
    }
    if (!onDrag) lastGearRef.current = 1;

    // Converter slip: how far ahead the engine is of where road speed says it
    // should be. High off the line, near zero once it couples.
    if (a.convG) {
      const isAuto = GEARBOX_OPTS[car.boxIdx].label === 'Automatic';
      const slip = onDrag && dragPt ? clamp(1 - dragPt.v / 12, 0, 1) : 0;
      a.convOsc.frequency.setTargetAtTime(240 + rpm * 0.055, t, 0.08);
      a.convFilt.frequency.setTargetAtTime(420 + rpm * 0.09, t, 0.08);
      a.convG.gain.setTargetAtTime(isAuto && audible ? slip * 0.055 : 0, t, 0.1);
    }

    const srcPt = onDyno ? dynoPt : live.live;
      const retardNow = srcPt ? Math.max(0, srcPt.commandedTiming - srcPt.timing) : 0;
      const rasp = clamp(retardNow / 12, 0, 1);

      // MIXTURE: a rich mixture burns slower and softer; lean is sharp and thin.
      const lam = srcPt ? srcPt.lambda : 1;
      const richness = clamp((1.0 - lam) * 2.2, -0.4, 0.8);

      // COMPRESSION: a higher-compression engine has a sharper pressure rise, heard
      // as a harder crack on each pulse.
      const crBite = clamp((engineConfig.compression - 10.3) * 0.06, -0.2, 0.25);

      a.filter.frequency.setTargetAtTime(
        (300 + fire * 7 + load * 2400) * diaOpen * (1 / dispDepth) * (1 + rasp * 0.45 + crBite), t, 0.05);
      // Each layout gets its own resonance shape:
      //  V8  — low, broad, loose: lets the uneven pulses blur into a rumble
      //  V6  — mid, narrow, ringing: pulses excite a strong tone, hence the horn
      //  I4  — higher, tight, hollow: few pulses, each clearly separate
      a.filter.Q.setTargetAtTime((isFour ? 4.5 : isEight ? 1.1 : 6.0) * (1 + crBite), t, 0.1);
      a.body.Q.setTargetAtTime(isEight ? 0.6 : isFour ? 1.4 : 3.6, t, 0.15);
      a.body2.Q.setTargetAtTime(isEight ? 0.9 : isFour ? 2.2 : 5.0, t, 0.15);
      a.body2G.gain.setTargetAtTime(((isEight ? 0.10 : isFour ? 0.20 : 0.34) + rasp * 0.18) * (0.35 + 0.65 * load), t, 0.12);
      a.pulseBus.gain.setTargetAtTime(isEight ? 1.25 : isFour ? 0.95 : 1.05, t, 0.15);
      a.bodyG.gain.setTargetAtTime((0.5 + (dia - 2.5) * 0.22) * dispDepth, t, 0.15);

    // EXHAUST PIPE RESONANCE, tied to the actual hardware.
    // A tube resonates at f = c / (2L). Bigger engines and bigger pipes mean a
    // longer, larger system, so the fundamental drops and the note deepens. A more
    // open system (larger bore, cat-back, headers) also reflects less at the outlet,
    // so it rings less — which is why a straight-through exhaust sounds "opened up"
    // rather than boomy.
    const pipeHz = clamp(105 - (dispL - 2.0) * 9 - (dia - 2.5) * 8, 52, 130);
    a.pipeDelay.delayTime.setTargetAtTime(1 / (2 * pipeHz), t, 0.15);

    // How hard the pipe rings depends on how much gas is moving through it. At idle
    // the flow is slow and the whole system is well muffled, so the resonance is
    // heavily damped — leaving it ringing there produces a metallic, hollow clang
    // that no real engine makes. Under load the pulses are strong and fast and the
    // pipe genuinely rings, which is where the character belongs.
    const flowFactor = clamp(0.18 + load * 0.62 + (rpm / 7500) * 0.30, 0.14, 1);
    a.pipeFb.gain.setTargetAtTime(
      clamp((0.30 + flowFactor * 0.20) - (dia - 2.5) * 0.05 - (catBack ? 0.04 : 0), 0.16, 0.46), t, 0.12);
    // Damping: a muffled system at idle only passes the low fundamental. Opening the
    // throttle lets the harmonics through, which is the "coming on song" effect.
    a.pipeDamp.frequency.setTargetAtTime(420 + flowFactor * (900 + diaOpen * 1200) + rasp * 500, t, 0.1);
    a.pipeOut.gain.setTargetAtTime(
      audible ? (isEight ? 1.10 : isFour ? 0.68 : 0.88) * (0.45 + 0.55 * flowFactor) : 0, t, 0.12);
      a.body2.frequency.setTargetAtTime((720 + fire * 4) * diaOpen * (1 + rasp * 0.3), t, 0.1);

      a.indG.gain.setTargetAtTime(mods.intake && audible ? load * 0.055 * (rpm / 7500 + 0.3) : 0, t, 0.06);

      if (turboOn) {
        // Shaft speed rises with engine speed AND with how hard the compressor is
        // working, so the whistle climbs with boost as well as RPM.
        const shaft = 900 + (rpm / 7500) * 3000 + boostNow * 60;
        const boostFrac = clamp(boostNow / 14, 0, 1.4);

        a.whistle.frequency.setTargetAtTime(shaft, t, 0.07);
        a.whistleG.gain.setTargetAtTime(audible ? Math.min(0.012, boostNow * 0.0014) * load : 0, t, 0.08);

        // Blade-pass band sits at the same frequency but is noise, not a tone. It
        // carries most of the character; the sine only adds the pitch centre.
        a.bladeFilt.frequency.setTargetAtTime(shaft, t, 0.07);
        a.bladeG.gain.setTargetAtTime(audible ? Math.min(0.22, boostFrac * 0.19) * (0.35 + 0.65 * load) : 0, t, 0.08);

        // Air rush tracks actual mass airflow — it is the sound of volume moving.
        const mafNow = onDyno ? (dynoPt?.maf ?? 0) : (live.live?.maf ?? 0);
        a.rushFilt.frequency.setTargetAtTime(800 + (mafNow / 250) * 1600, t, 0.1);
        // A small boosted engine is mostly induction noise — on a turbo four the
        // whoosh genuinely dominates the exhaust note, which is why they sound so
        // different from a big naturally aspirated engine making the same power.
        const smallEngineBias = clamp(2.6 / Math.max(engineDerived.displacementL, 1.2), 0.7, 2.1);
        a.rushG.gain.setTargetAtTime(
          audible ? Math.min(0.21, (mafNow / 250) * 0.10 * (0.4 + boostFrac) * smallEngineBias) : 0, t, 0.1);
        a.rushFilt.Q.setTargetAtTime(engineDerived.cyl === 4 ? 0.45 : 0.8, t, 0.15);

        // Blow-off fires whenever real boost was present and the throttle just shut —
        // including the moment a dyno pull ends, which is when you would hear it.
        const lifted = load < 0.15 || (!running && wasRunningRef.current);
        if (prevBoostRef.current > 1.5 && lifted && soundOn && a.flutEnv) {
          // Flutter rate rises with how much boost is trying to escape backwards.
          const flutHz = clamp(20 + prevBoostRef.current * 1.7, 20, 48);
          a.flutLfo.frequency.setValueAtTime(flutHz, t);
          a.flutFilt.frequency.cancelScheduledValues(t);
          a.flutFilt.frequency.setValueAtTime(1000 + prevBoostRef.current * 25, t);
          a.flutFilt.frequency.exponentialRampToValueAtTime(500, t + 0.55);
          a.flutEnv.gain.cancelScheduledValues(t);
          a.flutEnv.gain.setValueAtTime(clamp(0.30 + prevBoostRef.current * 0.030, 0.30, 0.85), t);
          a.flutEnv.gain.exponentialRampToValueAtTime(0.0001, t + 0.65);
        }
        if (prevBoostRef.current > 1.5 && lifted && soundOn) {
          const peak = clamp(0.55 + prevBoostRef.current * 0.045, 0.55, 1.25);
          a.bovG.gain.cancelScheduledValues(t);
          a.bovG.gain.setValueAtTime(peak, t);
          a.bovG.gain.exponentialRampToValueAtTime(0.0001, t + 0.95);
          // Pitch falls away as the trapped pressure bleeds down.
          a.bovFilt.frequency.cancelScheduledValues(t);
          a.bovFilt.frequency.setValueAtTime(3200 + prevBoostRef.current * 95, t);
          a.bovFilt.frequency.exponentialRampToValueAtTime(420, t + 0.85);
          prevBoostRef.current = 0;
        } else {
          prevBoostRef.current = boostNow;
        }
      } else {
        a.whistleG.gain.setTargetAtTime(0, t, 0.1);
        a.bladeG.gain.setTargetAtTime(0, t, 0.1);
        a.rushG.gain.setTargetAtTime(0, t, 0.1);
        prevBoostRef.current = 0;
      }
      wasRunningRef.current = running;

      // Lope is loudest at idle and washes out as revs rise and combustion evens up.
      const overlap = engineDerived.overlapDeg || 0;
      const lopeRate = clamp(fire / 7, 1.8, 11);
      a.lopeLfo.frequency.setTargetAtTime(lopeRate, t, 0.15);
      const lopeStrength = audible && overlap > 1.5 && rpm < 2600
        ? Math.min(0.42, overlap * 0.013) * clamp(1 - (rpm - 800) / 2000, 0.12, 1)
        : 0;
      a.lopeDepth.gain.setTargetAtTime(lopeStrength, t, 0.12);

      // Knock adds a hard, rattly edge — the audible reason tuners fear it.
      const knocking = srcPt && srcPt.knock ? Math.min(1, srcPt.knockPull / 8) : 0;
      a.ng.gain.setTargetAtTime(
        live.cranking && onLive ? 0.12 : 0.03 + load * 0.045 + contMix * 0.11 + Math.max(0, richness) * 0.03 + knocking * 0.06, t, 0.05);
      const vol = cut ? 0.10 : 0.55 + load * 0.60;
      a.outGain.gain.setTargetAtTime(2.4 * volume, t, 0.08);
      a.master.gain.setTargetAtTime(audible && soundOn ? vol * (catBack ? 1.18 : 1) : 0, t, cut ? 0.015 : 0.06);

    }

    // Fire the exhaust pulses. This effect re-runs on every engine tick and on every
    // step of a dyno sweep, so scheduling here keeps the pulse train in step with RPM.
    // Wheelspin adds broadband tyre noise on top of the exhaust.
    if (a.rushG && onDrag) {
      a.rushFilt.frequency.setTargetAtTime(dragPt?.spinning ? 2200 : 1200, t, 0.08);
      a.rushG.gain.setTargetAtTime(dragPt?.spinning ? 0.10 : 0, t, 0.08);
    }
    if (audible && soundOn) {
      const lvl = cut ? 0.14 : 0.42 + load * 0.62;
      schedulePulses(rpm, lvl, cyl, engineDerived.displacementL, engineDerived.overlapDeg || 0);
    }
  }, [live.rpm, live.running, live.cranking, live.effThrottle, live.fuelCut, live.live, soundOn,
      engineDerived.cyl, exhaustDiaIdx, mods.intake, mods.exhaust, mods.headers, turboOn,
      running, currentRpm, revealCount, result, tab, volume, dynoPhase, dragRunning, dragT, dragResult, car.boxIdx, engineDerived.overlapDeg,
      engineDerived.displacementL, engineConfig.compression, exhaustDiaIdx]);

  // HARD SILENCE. Scheduled ramps (gear shifts, blow-off, tree beeps) can leave a
  // gain parked open if a run ends mid-ramp. Rather than relying on the smoothing
  // in the main audio effect, this cancels every scheduled value and pins each
  // layer to zero the moment nothing should be making noise: engine stopped, dyno
  // pull finished, drag pass finished, or the page changed.
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const sounding =
      (tab === 'live' && (live.running || live.cranking)) ||
      (tab === 'dyno' && running) ||
      (tab === 'drag' && dragRunning);
    if (sounding) return;
    const t = a.ctx.currentTime;
    const kill = (node) => {
      if (!node) return;
      try { node.gain.cancelScheduledValues(t); node.gain.setValueAtTime(0, t); } catch { /* noop */ }
    };
    kill(a.master); kill(a.pipeOut); kill(a.indG);
    kill(a.whistleG); kill(a.bladeG); kill(a.rushG); kill(a.bovG); kill(a.flutEnv); kill(a.clunkG); kill(a.convG);
    [4, 6, 8].forEach((n) => (a.loopGains?.[n] || []).forEach(kill));
    if (a.lopeDepth) kill(a.lopeDepth);
  }, [tab, live.running, live.cranking, running, dragRunning]);

  // Hard-stop audio on unmount or when the tab changes away from a sounding page.
  useEffect(() => {
    return () => {
      const a = audioRef.current;
      if (a) { try { a.master.gain.setTargetAtTime(0, a.ctx.currentTime, 0.02); } catch { /* noop */ } }
    };
  }, [tab]);

  const overallHealth = Math.min(health.piston, health.bearing, health.valve);
  const overallColor = statusColor(overallHealth);
  const engineName = `${engineDerived.displacementL.toFixed(1)}L ${engineConfig.configuration}`;

  // Four top-level destinations instead of seven. The three tuning tables and the
  // fuel/ECU controls now live under TUNE as sub-views — same depth, far less to
  // scan, and much bigger touch targets.
  // Nav follows the real working order: design it, calibrate it, hear it run,
  // then measure it. HOME is the hub (career jobs, stats, learning).
  const TABS = [
    { id: 'dash', label: 'HOME', icon: Gauge },
    { id: 'build', label: 'BUILD', icon: Settings },
    { id: 'tune', label: 'TUNE', icon: Grid3x3 },
    { id: 'live', label: 'LIVE', icon: Flame },
    { id: 'dyno', label: 'DYNO', icon: Activity },
    { id: 'drag', label: 'DRAG', icon: Flag },
  ];
  const TUNE_VIEWS = [
    { id: 've', label: 'AIR', icon: Grid3x3 },
    { id: 'timing', label: 'SPARK', icon: Zap },
    { id: 'afr', label: 'FUEL', icon: Droplets },
    { id: 'ecu', label: 'ECU', icon: Fuel },
  ];
  const gridProps = { selection, setSelection, rowIdx: visibleRows, rangeMode };

  // Shown above each tuning table. Single mode edits one cell; range mode lets you
  // tap two corners and edit everything between them at once.
  const SelectModeBar = () => (
    <div style={{ display: 'flex', gap: 7, alignItems: 'center', marginBottom: 8 }}>
      <button onClick={() => { setRangeMode(false); setSelection(null); }} style={{
        flex: 1, padding: '9px 0', borderRadius: 8, fontWeight: 800, fontSize: 11,
        border: `1px solid ${!rangeMode ? T.amber : T.line}`,
        background: !rangeMode ? T.amberBg : T.panel2, color: !rangeMode ? T.amberInk : T.ink2,
      }}>SINGLE CELL</button>
      <button onClick={() => { setRangeMode(true); setSelection(null); }} style={{
        flex: 1, padding: '9px 0', borderRadius: 8, fontWeight: 800, fontSize: 11,
        border: `1px solid ${rangeMode ? T.amber : T.line}`,
        background: rangeMode ? T.amberBg : T.panel2, color: rangeMode ? T.amberInk : T.ink2,
      }}>SELECT RANGE</button>
      <button onClick={() => setSelection({ type: 'range', r1: visibleRows[0], c1: 0, r2: visibleRows[visibleRows.length - 1], c2: RPM.length - 1, complete: true })} style={{
        padding: '9px 12px', borderRadius: 8, fontWeight: 800, fontSize: 11,
        border: `1px solid ${T.line}`, background: T.panel2, color: T.ink2,
      }}>ALL</button>
    </div>
  );

  if (appView === 'start') return (
    <StartScreen
      onStart={() => { setMode('sandbox'); setAppView('app'); setTab('build'); }}
      onCareer={() => { setMode('career'); setAppView('app'); setTab('dash'); setDashSection('career'); setJourneyStep(99); }}
      onTutorial={() => setAppView('tutorial')}
    />
  );
  if (appView === 'tutorial') return <TutorialScreen onDone={() => { setAppView('start'); }} />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100dvh', maxHeight: '100dvh', background: T.bg, color: T.ink, fontFamily: T.sans, overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ padding: '13px 16px 12px', borderBottom: `1px solid ${T.line}`, background: T.panel }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div style={{ fontSize: 10, letterSpacing: 2, color: T.amberInk, fontWeight: 800 }}>CARIBOU TUNING</div>
            <div style={{ fontSize: 16.5, fontWeight: 800, letterSpacing: 0.2 }}>ECU Lab</div>
            <div style={{ fontSize: 11, color: T.ink2, marginTop: 3, fontFamily: T.mono }}>
              {engineName} · {turboOn ? 'Turbo' : 'N/A'} · {OCTANE_OPTS[octaneIdx].label} oct · {INJECTOR_OPTS[injIdx].label} · {BUILD_VERSION}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
            <button onClick={() => { stopEngine(); setAppView('start'); }} title="Back to menu" style={{ background: T.panel2, border: `1px solid ${T.line}`, borderRadius: 9, padding: '9px 11px', color: T.ink2, fontSize: 11, fontWeight: 800 }}>
              MENU
            </button>
            <button onClick={() => setAppView('tutorial')} title="Tutorial" style={{ background: T.panel2, border: `1px solid ${T.line}`, borderRadius: 9, padding: 9, color: T.ink2 }}>
              <Info size={16} />
            </button>
            <button onClick={repairEngine} title="Repair engine" style={{ background: T.panel2, border: `1px solid ${T.line}`, borderRadius: 9, padding: 9, color: T.ink2 }}>
              <Wrench size={16} />
            </button>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 9 }}>
          <div style={{ flex: 1, height: 4, background: T.panel2, borderRadius: 2, overflow: 'hidden', border: `1px solid ${T.line}` }}>
            <div style={{ width: `${overallHealth}%`, height: '100%', background: overallColor, transition: 'width .4s' }} />
          </div>
          <span style={{ fontSize: 10, color: overallColor, fontWeight: 800, fontFamily: T.mono }}>{Math.round(overallHealth)}%</span>
          {live.running && <span style={{ fontSize: 9.5, color: T.green, fontWeight: 800, letterSpacing: 0.5 }}>● RUNNING</span>}
        </div>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
        {/* ---------- HOME: live engine, career stats, health, learning ---------- */}
        {tab === 'dash' && (
          <div style={{ padding: 16 }}>
            {mode === 'career' && (
              <BuildSection
                active={dashSection === 'career'} onClick={() => setDashSection(dashSection === 'career' ? null : 'career')}
                icon={Trophy} label="Career — Customer Cars"
                sub={`${completedJobs.length}/${CAREER_JOBS.length} completed`}
              >
                {activeJob != null && (
                  <Panel style={{ marginBottom: 12, borderColor: T.amber }}>
                    <div style={{ fontSize: 10, letterSpacing: 1, color: T.amberInk, fontWeight: 800 }}>CURRENT JOB</div>
                    <div style={{ fontSize: 14, fontWeight: 800, color: T.ink, marginTop: 3 }}>{CAREER_JOBS[activeJob].title}</div>
                    <div style={{ fontSize: 12, color: '#a5aebb', lineHeight: 1.55, marginTop: 7 }}>{CAREER_JOBS[activeJob].brief}</div>
                    <div style={{ fontSize: 12, color: T.amberInk, marginTop: 8, fontWeight: 700 }}>Target: {CAREER_JOBS[activeJob].target}</div>
                    <button onClick={() => { setActiveJob(null); setJobResult(null); }} style={{ marginTop: 10, width: '100%', padding: '9px 0', borderRadius: 8, border: `1px solid ${T.line}`, background: T.panel, color: T.ink2, fontWeight: 700, fontSize: 11.5 }}>
                      ABANDON JOB
                    </button>
                  </Panel>
                )}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {CAREER_JOBS.map((j, i) => {
                    const done = completedJobs.includes(i);
                    const current = activeJob === i;
                    return (
                      <button key={j.id} onClick={() => takeJob(i)} style={{
                        textAlign: 'left', padding: '11px 13px', borderRadius: 10,
                        border: `1px solid ${current ? T.amber : done ? '#1f4a30' : T.line}`,
                        background: current ? T.amberBg : done ? T.greenBg : T.panel2,
                      }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                          <span style={{ fontWeight: 700, fontSize: 13, color: done ? T.green : T.ink }}>{j.title}</span>
                          <span style={{ fontSize: 10, fontWeight: 800, color: done ? T.green : current ? T.amberInk : T.ink3, flexShrink: 0 }}>
                            {done ? 'COMPLETE' : current ? 'ACTIVE' : 'TAKE JOB'}
                          </span>
                        </div>
                        <div style={{ fontSize: 11.5, color: T.ink2, marginTop: 4, lineHeight: 1.45 }}>{j.customer}</div>
                      </button>
                    );
                  })}
                </div>
                <Note>Taking a job resets the car and applies that customer's fault. Diagnose it from the pull log — the cause is always something the simulation genuinely models.</Note>
              </BuildSection>
            )}

            <BuildSection
              active={dashSection === 'stats'} onClick={() => setDashSection(dashSection === 'stats' ? null : 'stats')}
              icon={Trophy} label="Career & Last Pull"
              sub={result ? `Best ${bestScore} · ${pullCount} pulls logged` : `${pullCount} pulls logged`}
            >
              <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
                <StatTile label="BEST PULL" value={bestScore} color={T.amberInk} />
                <StatTile label="CAREER TOTAL" value={totalScore} color={T.cyan} />
                <StatTile label="PULLS" value={pullCount} color={T.ink} />
              </div>
              {result && scores ? (
                <>
                  <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
                    <StatTile label="PEAK POWER" value={result.peakHp} unit="whp" color={T.amberInk} />
                    <StatTile label="PEAK TORQUE" value={result.peakTq} unit="lb-ft" color={T.cyan} />
                  </div>
                  <div style={{ display: 'flex', gap: 10 }}>
                    <StatTile label="PULL SCORE" value={scores.pull} color={T.amberInk} />
                    <StatTile label="TUNING" value={scores.tuning.score} color={statusColor(scores.tuning.score)} />
                    <StatTile label="ENGINEER" value={scores.engineer.score} color={statusColor(scores.engineer.score)} />
                  </div>
                </>
              ) : <Note>No dyno pull logged yet — head to DYNO and run one.</Note>}
            </BuildSection>

            <BuildSection
              active={dashSection === 'health'} onClick={() => setDashSection(dashSection === 'health' ? null : 'health')}
              icon={Wrench} label="Engine Health"
              sub={`${Math.round(overallHealth)}% overall`}
            >
              <Panel>
                <HealthBar label="PISTON / RINGS · knock, detonation" value={health.piston} />
                <HealthBar label="BEARINGS · sustained cylinder pressure" value={health.bearing} />
                <HealthBar label="VALVES · lean-under-boost heat" value={health.valve} />
              </Panel>
              {needsMafRecal && <Note tone="warn">Your intake and/or turbo plumbing changed the MAF reading — head to <b>FUEL</b> to rescale it before your next pull.</Note>}
            </BuildSection>

            <BuildSection
              active={dashSection === 'learn'} onClick={() => setDashSection(dashSection === 'learn' ? null : 'learn')}
              icon={BookOpen} label="Learn How It Works"
              sub="Plain-language guide to engine tuning"
            >
              <div style={{ fontSize: 12, color: T.ink3, marginBottom: 10, lineHeight: 1.5 }}>Read in order. Each explains a piece of what the live engine is doing right now.</div>

              <div style={{ fontSize: 11, letterSpacing: 1, color: T.amberInk, fontWeight: 800, margin: '4px 0 8px' }}>PART 1 · FUNDAMENTALS</div>

              <ExpandableInfo title="1. The whole thing in one paragraph">
                An engine is an air pump. However much air it swallows decides how much fuel can be burned, and burning fuel is what makes power. The ECU's entire job is to measure the air, add the right amount of fuel, and light it at the right moment. Tuning is adjusting those last two decisions.
                <br /><br />Everything else in this app — cams, turbos, exhaust diameter, compression — exists to change how much air gets in, or how much of that fuel's energy you can safely extract.
              </ExpandableInfo>

              <ExpandableInfo title="2. Volumetric efficiency — the master number">
                VE is how completely a cylinder fills compared to its own swept volume. At 100% VE the cylinder takes in exactly its displacement worth of air at the pressure available. Naturally aspirated engines typically peak around 85–100%; the peak sits at the RPM where the intake and exhaust tuning line up best, which is also where peak torque lands.
                <br /><br />VE falls off at high RPM because there simply is not enough time to fill the cylinder, and it falls at very low RPM because gas velocity is too low to help. That curve is the shape of your torque curve.
                <br /><br /><b style={{ color: T.ink }}>Every hardware choice on BUILD moves this table</b> — cam duration slides the peak up or down the RPM range, headers and exhaust add flow up top, bore/stroke ratio biases the whole curve. That is why VE is where hardware becomes visible.
              </ExpandableInfo>

              <ExpandableInfo title="3. Lambda — the only mixture number that matters">
                Gasoline burns completely at about 14.7 parts air to 1 part fuel. Divide any AFR by its fuel's stoichiometric ratio and you get <b style={{ color: T.ink }}>lambda</b>: 1.00 is exactly complete combustion, below 1 is rich, above 1 is lean.
                <br /><br />Lambda matters because it means the same thing on every fuel. E85 is stoichiometric at about 9.8:1, so 12.5:1 means something completely different on E85 than on pump gas — but lambda 0.85 is lambda 0.85 on both.
                <br /><br />Best power is slightly rich: around <b style={{ color: T.ink }}>lambda 0.87</b> naturally aspirated, and richer still under boost — near 0.83 — because the extra fuel evaporating cools the charge and buys knock margin. Leaner than that under load and you lose power while raising both knock risk and exhaust temperature.
              </ExpandableInfo>

              <ExpandableInfo title="4. Why timing makes torque, and where it stops">
                Fuel does not explode instantly — it burns over a few milliseconds. So the spark fires <i>before</i> top dead center, timed so peak cylinder pressure arrives around 16° after TDC, where the crank has the best leverage.
                <br /><br />Too retarded and you are still burning while the piston runs away: wasted energy, hot exhaust. Too advanced and pressure peaks while the piston is still rising, fighting the crank and building the heat and pressure that cause knock. The best point is <b style={{ color: T.ink }}>MBT</b> — minimum spark for best torque. Past MBT you gain almost nothing and risk everything.
                <br /><br />MBT moves: higher RPM needs more advance because there is less time for the burn; higher load needs less because the denser charge burns faster.
              </ExpandableInfo>

              <ExpandableInfo title="5. Knock — what actually destroys engines">
                Knock is the end gas — the mixture farthest from the spark plug — igniting on its own from heat and pressure before the flame front reaches it. Two flame fronts collide and the pressure spike hammers the piston and ring lands.
                <br /><br />It is driven by <b style={{ color: T.ink }}>trapped charge mass</b>, not just boost: more air in the cylinder means higher peak pressure. That is why a big cam that breathes better also needs a little less timing, and why the same tune that is safe at part throttle knocks at wide open.
                <br /><br />What makes it worse: more timing, more boost, more compression, hotter intake air, leaner mixture, lower octane. What buys margin: higher octane, richer mixture, cooler charge (intercooler), aluminium head, less compression.
                <br /><br /><b style={{ color: T.ink }}>How much is too much?</b> Tuners treat anything sustained above about 2° of retard as damaging, not as an operating point. Zero is the target.
              </ExpandableInfo>

              <div style={{ fontSize: 11, letterSpacing: 1, color: T.amberInk, fontWeight: 800, margin: '14px 0 8px' }}>PART 2 · WHAT THE ECU CALCULATES</div>

              <ExpandableInfo title="Symbol key — plain-English version">
                Read this once and the formulas below stop looking like maths and start looking like a description of what the engine is doing.
                <br /><br />
                <b style={{ color: T.amberInk }}>AIR SIDE</b><br />
                <b style={{ fontFamily: T.mono, color: T.cyan, fontSize: 11.5 }}>MAP</b> — manifold absolute pressure. <i>How hard the air is being pushed toward the cylinder.</i> ~101 kPa is atmospheric; ~20-30 kPa at idle (the throttle is shut so the engine pulls vacuum); above 101 means a turbo is pushing. Formulas need it in pascals, so kPa × 1000.<br /><br />
                <b style={{ fontFamily: T.mono, color: T.cyan, fontSize: 11.5 }}>T</b> — charge temperature in <b style={{ color: T.ink }}>kelvin</b>, not celsius. Add 273.15 to your °C. It must be absolute because at 0 K a gas has zero volume; celsius has no such meaning and the formula would break.<br /><br />
                <b style={{ fontFamily: T.mono, color: T.cyan, fontSize: 11.5 }}>R</b> — gas constant for air, 287 J/(kg·K). <i>A property of air itself.</i> Never a tuning value; it is the same on every engine on earth.<br /><br />
                <b style={{ fontFamily: T.mono, color: T.cyan, fontSize: 11.5 }}>ρ</b> (rho) — air density in kg/m³. <i>How much air is actually packed into a given space.</i> Cold dense air = more oxygen = more possible power. This is why the same car makes more power on a cold night.<br /><br />
                <b style={{ fontFamily: T.mono, color: T.cyan, fontSize: 11.5 }}>VE</b> — volumetric efficiency, as a fraction. <i>How good the engine is at filling its own cylinders.</i> A 95% cell means the cylinder took in 95% of what its volume could theoretically hold at that pressure.<br /><br />
                <b style={{ fontFamily: T.mono, color: T.cyan, fontSize: 11.5 }}>V_cyl</b> — swept volume of ONE cylinder in m³ (total displacement ÷ number of cylinders). <b style={{ fontFamily: T.mono, color: T.cyan, fontSize: 11.5 }}>Vd</b> — the whole engine's displacement in m³. A 3.5 L engine is 0.0035 m³.
                <br /><br /><b style={{ color: T.amberInk }}>FUEL SIDE</b><br />
                <b style={{ fontFamily: T.mono, color: T.cyan, fontSize: 11.5 }}>stoichRatio</b> — the air:fuel mass ratio at which fuel and oxygen exactly consume each other. <i>A chemical property of the fuel, not a choice.</i> 14.7:1 for gasoline, 9.8:1 for E85.<br /><br />
                <b style={{ fontFamily: T.mono, color: T.cyan, fontSize: 11.5 }}>λ</b> (lambda) — measured AFR ÷ that fuel's stoichRatio. <i>How rich or lean you are, expressed so it means the same thing on any fuel.</i> 1.00 = exactly balanced, 0.85 = 15% more fuel than strictly needed (rich, and where power lives), 1.10 = lean.<br /><br />
                <b style={{ fontFamily: T.mono, color: T.cyan, fontSize: 11.5 }}>LHV</b> — lower heating value, J/kg. <i>How much energy is in a kilogram of the fuel.</i> Gasoline ~44 MJ/kg, E85 ~29.2 MJ/kg. E85 has less energy per kg but you burn far more kg, which is why power comes out similar.<br /><br />
                <b style={{ fontFamily: T.mono, color: T.cyan, fontSize: 11.5 }}>PW</b> — injector pulse width, milliseconds. <i>How long the injector is held open.</i> The ECU does not command fuel; it commands time.
                <br /><br /><b style={{ color: T.amberInk }}>OUTPUT SIDE</b><br />
                <b style={{ fontFamily: T.mono, color: T.cyan, fontSize: 11.5 }}>CR</b> — compression ratio, e.g. 10.3 means the mixture is squeezed into 1/10.3 of its original volume.<br /><br />
                <b style={{ fontFamily: T.mono, color: T.cyan, fontSize: 11.5 }}>η</b> (eta) — thermal efficiency, a fraction between 0 and 1. <i>The share of the fuel's chemical energy that becomes useful work instead of heat out the exhaust.</i> Around 0.35 is typical; most of the fuel's energy is genuinely wasted as heat.<br /><br />
                <b style={{ fontFamily: T.mono, color: T.cyan, fontSize: 11.5 }}>MEP</b> — mean effective pressure. <i>The single average pressure that, applied to the piston for one stroke, would do the same work the real varying pressure does.</i> It is a way of comparing engines of different sizes fairly, and it comes in three flavours:<br />
                &nbsp;&nbsp;<b style={{ fontFamily: T.mono, color: T.cyan, fontSize: 11.5 }}>IMEP</b> what combustion produced on the piston<br />
                &nbsp;&nbsp;<b style={{ fontFamily: T.mono, color: T.cyan, fontSize: 11.5 }}>FMEP</b> what the engine spends on itself (rubbing friction, pumping air past a closed throttle, compressing valve springs)<br />
                &nbsp;&nbsp;<b style={{ fontFamily: T.mono, color: T.cyan, fontSize: 11.5 }}>BMEP</b> what is left and reaches the crank = IMEP − FMEP<br />
                A healthy naturally aspirated engine peaks around 11-13 bar BMEP. Below zero means the engine cannot even overcome its own losses — which is exactly what engine braking is.<br /><br />
                <b style={{ fontFamily: T.mono, color: T.cyan, fontSize: 11.5 }}>MBT</b> — minimum spark advance for best torque. <i>The least amount of advance that still makes maximum power.</i> "Minimum" matters: past MBT you gain nothing and only add knock risk.
                <br /><br /><b style={{ color: T.amberInk }}>TWO CONSTANTS THAT LOOK ARBITRARY</b><br />
                <b style={{ fontFamily: T.mono, color: T.cyan, fontSize: 11.5 }}>4π</b> in the torque formula: a four-stroke fires once every <b style={{ color: T.ink }}>two</b> crank revolutions. Work per cycle is MEP × Vd, and two revolutions is 4π radians, so torque = work ÷ angle = MEP × Vd ÷ 4π. A two-stroke fires every revolution and uses 2π.<br /><br />
                <b style={{ fontFamily: T.mono, color: T.cyan, fontSize: 11.5 }}>120000</b> in the duty cycle formula: one injection per two revolutions. Two revolutions at N rpm takes 2 ÷ (N/60) seconds = 120/N seconds = <b style={{ color: T.ink }}>120000/N milliseconds</b>. At 7500 rpm that is 16 ms — the entire time budget the injector has.
              </ExpandableInfo>

              <ExpandableInfo title="6. The control loop, in order">
                Thousands of times a minute, the ECU runs the same sequence:
                <br /><br />read sensors → calculate cylinder air mass → decide open or closed loop → work out required fuel mass → convert that to an injector pulse width → apply fuel trims → look up ignition timing → check for knock → retard if needed → fire injectors and coils → update learned values.
                <br /><br />Everything you edit in this app is one of the lookups inside that loop. The ECU is not deciding anything creative — it is doing arithmetic against your tables, very fast.
              </ExpandableInfo>

              <ExpandableInfo title="7. Step 1 — how much air is in the cylinder?">
                This is the ideal gas law, and it is the foundation of every speed-density calculation:
                <br /><br /><span style={{ fontFamily: T.mono, color: T.cyan, fontSize: 11.5 }}>ρ = MAP ÷ (R × T)</span><br />
                <span style={{ fontFamily: T.mono, color: T.cyan, fontSize: 11.5 }}>airCharge = VE × V_cylinder × ρ</span>
                <br /><br />MAP is manifold pressure (about 101 kPa at wide open naturally aspirated, higher with boost, down to ~20 kPa at idle). R is the gas constant for air, 287 J/(kg·K). T is charge temperature.
                <br /><br />Two consequences worth internalising. <b style={{ color: T.ink }}>Boost raises MAP</b>, so it directly multiplies air mass. And <b style={{ color: T.ink }}>compressing air heats it</b>, which lowers density and gives some of that gain back — which is the entire reason intercoolers exist. You can watch both in the datalog's MAP and IAT columns.
              </ExpandableInfo>

              <ExpandableInfo title="8. Step 2 — how much fuel does that need?">
                Fuel mass follows directly from air mass and your lambda target:
                <br /><br /><span style={{ fontFamily: T.mono, color: T.cyan, fontSize: 11.5 }}>fuelMass = airCharge ÷ (λ × stoichRatio)</span>
                <br /><br />Nothing is fudged here. Because E85's stoichiometric ratio is 9.8 instead of 14.7, the same lambda target automatically demands about 1.5× the fuel mass — it falls straight out of the chemistry, which is why E85 needs a much bigger fuel system for the same power.
              </ExpandableInfo>

              <ExpandableInfo title="9. Step 3 — pulse width, and the hard time limit">
                The ECU never commands "fuel" — it commands a number of milliseconds. That comes from the required fuel mass and the injector's flow rating, plus deadtime (the ~1 ms an injector takes to physically open):
                <br /><br /><span style={{ fontFamily: T.mono, color: T.cyan, fontSize: 11.5 }}>PW = fuelMass ÷ (injectorCC × density ÷ 60000) + deadtime</span><br />
                <span style={{ fontFamily: T.mono, color: T.cyan, fontSize: 11.5 }}>cycleTime = 120000 ÷ RPM&nbsp;&nbsp;(ms per 720° cycle)</span><br />
                <span style={{ fontFamily: T.mono, color: T.cyan, fontSize: 11.5 }}>duty% = PW ÷ cycleTime × 100</span>
                <br /><br />A four-stroke injects once every two crank revolutions, so at 7500 RPM there are only 16 ms in a cycle. An injector needing 15 of them is at 94% duty. Past about 90% there is no time left, and the mixture goes lean <i>no matter what your AFR table says</i>. This is a physical wall, not a calibration choice.
                <br /><br /><b style={{ color: T.ink }}>Critical:</b> the ECU calculates that pulse width for the injector size it has been <i>told</i> is fitted. Fit bigger injectors without updating the ECU Injector Size on FUEL and every pulse delivers proportionally more fuel than intended — the engine runs rich everywhere regardless of your tables.
              </ExpandableInfo>

              <ExpandableInfo title="10. Step 4 — open loop, closed loop, and fuel trims">
                At part throttle the ECU runs <b style={{ color: T.ink }}>closed loop</b>: it reads the oxygen sensor and corrects fuelling in real time. <b style={{ color: T.ink }}>Short term fuel trim (STFT)</b> is that instant correction; <b style={{ color: T.ink }}>long term fuel trim (LTFT)</b> is what it has learned and stored over time. Watch both on the HOME gauges — fit an intake without rescaling the MAF and you can see STFT swing, then hand off to LTFT as it learns.
                <br /><br />Above roughly 85 kPa the ECU switches to <b style={{ color: T.ink }}>open loop</b> and stops listening to the O2 sensor entirely, following your tables blind. That is deliberate — at wide open throttle you want a rich power mixture, not stoichiometric.
                <br /><br />It is also why <b style={{ color: T.ink }}>wide open throttle is where a bad tune bites</b>. Errors that closed loop quietly papers over at cruise pass straight through at full load.
              </ExpandableInfo>

              <ExpandableInfo title="11. Step 5 — from combustion to torque at the wheels">
                Fuel energy becomes indicated work on the piston, then the engine pays its own bills:
                <br /><br /><span style={{ fontFamily: T.mono, color: T.cyan, fontSize: 11.5 }}>η = (1 − 1/CR^0.30) × 0.759</span><br />
                <span style={{ fontFamily: T.mono, color: T.cyan, fontSize: 11.5 }}>IMEP = fuelMass × LHV × η × timingEff × afrEff ÷ V_cyl</span><br />
                <span style={{ fontFamily: T.mono, color: T.cyan, fontSize: 11.5 }}>FMEP = rubbing friction + pumping loss + spring load</span><br />
                <span style={{ fontFamily: T.mono, color: T.cyan, fontSize: 11.5 }}>BMEP = IMEP − FMEP</span><br />
                <span style={{ fontFamily: T.mono, color: T.cyan, fontSize: 11.5 }}>torque = BMEP × Vd ÷ 4π</span>
                <br /><br /><b style={{ color: T.ink }}>Line 1 — thermal efficiency.</b> This is the air-standard Otto efficiency, <span style={{ fontFamily: T.mono, color: T.cyan }}>η = 1 − 1/r^(γ−1)</span>, where r is compression ratio and γ is the ratio of specific heats of the gas in the cylinder. The exponent 0.30 corresponds to γ = 1.3 — the value MIT 8.21 gives for combustion products at 1500–2500 K. It is multiplied by 0.759 because no real engine reaches the ideal: combustion is not instantaneous, heat escapes through the cylinder walls, and the exhaust does not blow down at constant volume.
                <br /><br />At 10.3:1 that gives 0.503 ideal and 0.382 indicated. For scale, MIT states real spark-ignition engines reach 35–40% at their absolute best, and most cars average 20–25% delivered. Roughly two-thirds of the fuel you burn leaves as heat no matter how well it is tuned. Raising compression genuinely raises this figure — which is why it makes power — but it raises knock risk at the same time, which is why pump fuel limits you to around 10:1.
                <br /><br /><b style={{ color: T.ink }}>Pumping loss</b> is the one people forget: at part throttle the engine is working hard to breathe against a closed throttle, and that shows up as wasted work. It is why fuel consumption per horsepower gets much worse at light load, and why a throttled engine brakes itself on overrun.
              </ExpandableInfo>

              <div style={{ fontSize: 11, letterSpacing: 1, color: T.amberInk, fontWeight: 800, margin: '14px 0 8px' }}>PART 3 · THE TUNING PROCESS</div>

              <ExpandableInfo title="12. The loop: change → pull → read → adjust">
                This is the whole method, and it is not a simplification:
                <br /><br /><b style={{ color: T.ink }}>1. Change one thing.</b> One table region, one hardware item. Change three and you will not know which one mattered.
                <br /><br /><b style={{ color: T.ink }}>2. Run a pull.</b> Nothing is known until it is measured. There is no preview in this app on purpose.
                <br /><br /><b style={{ color: T.ink }}>3. Read the log first.</b> Before looking at the power number, read the Pull Log and check the datalog for gaps between commanded and actual. Power that came with 6° of knock retard is not power you keep.
                <br /><br /><b style={{ color: T.ink }}>4. Adjust and repeat.</b> The VS. LAST PULL line tells you whether the change helped. Small logged steps beat big guesses, every time.
              </ExpandableInfo>

              <ExpandableInfo title="13. A worked example — first turbo tune">
                Fit a turbo on BUILD and run a pull without touching anything. It will score terribly, and here is why: a factory naturally-aspirated calibration has no real tuning above 101 kPa, so the boost rows are just a flat continuation of the wide-open-throttle row — far too much timing and far too lean for the cylinder pressure you have just created.
                <br /><br /><b style={{ color: T.ink }}>Read the log.</b> It will report knock across most of the range, with the RPM band and how many degrees the ECU pulled.
                <br /><br /><b style={{ color: T.ink }}>Fix the spark first.</b> On SPARK, pull the 150 and 200 kPa rows down. Roughly 2° per 20 kPa of extra pressure is a sane starting point. Pull again.
                <br /><br /><b style={{ color: T.ink }}>Then the mixture.</b> On FUEL, richen those same rows toward lambda 0.83 (about 12.2:1). Pull again — you should see knock margin improve as well, because a richer charge resists knock.
                <br /><br /><b style={{ color: T.ink }}>Then check the fuel system.</b> If the log reports injectors maxed, that is hardware: fit bigger injectors and set the matching ECU Injector Size, or ask for less boost. Nothing in the tables can create fuel that the injectors have no time to deliver.
              </ExpandableInfo>

              <ExpandableInfo title="14. How to read the datalog columns">
                The datalog is where diagnosis actually happens. Read it in pairs:
                <br /><br /><b style={{ color: T.ink }}>Timing: asked → got</b> — if they differ, the ECU overrode you. That is knock retard, and the gap is how far past the limit your table was.
                <br /><br /><b style={{ color: T.ink }}>Mixture: asked → got</b> — if actual is not what you commanded, the cause is upstream of the fuel table: usually MAF scaling or injectors out of duty. Do not "fix" it by editing fuel cells; fix the cause.
                <br /><br /><b style={{ color: T.ink }}>Airflow</b> — around 200 g/s is typical at redline for an engine near 300 hp, which is a quick sanity check on whether your VE table is plausible.
                <br /><br /><b style={{ color: T.ink }}>Injectors</b> — duty above 90% is the wall. <b style={{ color: T.ink }}>Heat</b> — sustained EGT above ~950°C cooks turbines and valves; it rises with retarded timing and lean mixtures.
              </ExpandableInfo>

              <ExpandableInfo title="15. What tuning can fix, and what it can't">
                <b style={{ color: T.ink }}>Calibration faults — tables fix these completely:</b> knock (pull timing), lean or rich mixture (AFR table), MAF drift after an intake change (MAF scalar), injector mismatch (set the ECU injector size). Fix the cause and the score returns to 100.
                <br /><br /><b style={{ color: T.ink }}>Physical limits — no table touches these:</b> injectors out of duty cycle, valve float, a compressor past its efficient range, a cam that has moved the powerband somewhere you did not want. The Pull Log always names both routes when you hit one: change the hardware, or ask less of it.
                <br /><br />Knowing which kind of problem you are looking at is most of what separates a tuner from someone guessing at numbers.
              </ExpandableInfo>

              <ExpandableInfo title="16. Why the engine sounds the way it does">
                The sound here is not a recording — it is generated from the same numbers the physics produces, so every change is audible for a real reason.
                <br /><br /><b style={{ color: T.ink }}>Sound is a train of exhaust pulses.</b> Each cylinder firing vents a pressure wave. Those discrete pulses, and the spacing between them, are the sound:
                <br /><br /><span style={{ fontFamily: T.mono, color: T.cyan, fontSize: 11.5 }}>firingHz = RPM ÷ 60 × cylinders ÷ 2</span>
                <br /><br />A four-stroke fires each cylinder once per two revolutions, hence the ÷2. At 3000 RPM a V8 produces 200 pulses per second and an inline four only 100 — which is why a four sounds hollow and separated while a V8 sounds continuous.
                <br /><br /><b style={{ color: T.ink }}>The V8 rumble is uneven firing, not EQ.</b> A cross-plane V8 fires unevenly within each bank: at 3000 RPM the gaps alternate about 3.6 ms and 6.4 ms instead of an even 5.0 ms. That irregularity <i>is</i> the rumble — even-fire the same engine and it stops sounding like a V8. A 60/120° V6 fires evenly, so its pulses ring the exhaust cleanly and it sounds hard and hornlike.
                <br /><br /><b style={{ color: T.ink }}>What each change does:</b><br />
                <b style={{ color: T.ink }}>Cylinder count</b> — pulse rate and spacing pattern. The biggest single factor.<br />
                <b style={{ color: T.ink }}>Displacement</b> — bigger cylinders vent longer pressure pulses, so the resonance sits lower and the note deepens.<br />
                <b style={{ color: T.ink }}>Cam duration</b> — overlap makes combustion inconsistent at idle, so output surges and dips. That is lope.<br />
                <b style={{ color: T.ink }}>Exhaust diameter</b> — a bigger pipe restricts less and resonates lower: louder and deeper.<br />
                <b style={{ color: T.ink }}>Intake</b> — induction noise rising with airflow.<br />
                <b style={{ color: T.ink }}>Turbo</b> — the whistle is blade-pass frequency tracking shaft speed; the rush is broadband noise from real mass airflow. On a small engine that induction noise dominates the exhaust, which is why a turbo four whooshes rather than barks.<br />
                <b style={{ color: T.ink }}>Ignition timing</b> — retarded means the charge is still burning as the exhaust valve opens, dumping energy into the exhaust. Heard as a harder, raspier note; measured as higher EGT.<br />
                <b style={{ color: T.ink }}>Mixture</b> — rich burns slower and softer, lean is sharp and thin.<br />
                <b style={{ color: T.ink }}>Compression</b> — faster pressure rise gives a harder crack per pulse.<br />
                <b style={{ color: T.ink }}>Knock</b> — a rattly edge, because that is literally what knock is: a shockwave ringing the cylinder.
                <br /><br />This matters beyond the game. Tuners diagnose by ear constantly — a lumpy idle, a lean rasp, a knock rattle. The sound is data.
              </ExpandableInfo>

              <div style={{ fontSize: 11, letterSpacing: 1, color: T.amberInk, fontWeight: 800, margin: '14px 0 8px' }}>PART 4 · TAKING THIS TO A REAL CAR</div>

              <ExpandableInfo title="17. What the tables are called on real software">
                The concepts here are universal; only the names change. If you open a real title, this is the translation:
                <br /><br /><b style={{ color: T.ink }}>Airflow</b> — HP Tuners and EFILive call it the <i>VE table</i> on RPM × MAP, exactly as here. COBB and EcuTek often expose <i>Load</i> or <i>Airmass</i>. UpRev on Nissan barely exposes VE at all; you correct airflow through the <i>MAF curve</i> (indexed by sensor voltage) plus the <i>K-fuel multiplier</i>. Different knob, same job: tell the ECU how much air is really there.
                <br /><br /><b style={{ color: T.ink }}>Fuel target</b> — <i>Commanded AFR</i>, <i>AFR target</i>, <i>Lambda target</i>, or <i>Equivalence ratio</i> (which is 1/λ, so it reads inverted — check which one you have before you edit anything).
                <br /><br /><b style={{ color: T.ink }}>Spark</b> — <i>Ignition timing</i>, <i>Spark advance</i>, or <i>Base spark</i>, usually with separate <i>knock retard</i> and <i>intake-air-temperature correction</i> tables layered on top. This app folds those corrections into one number for clarity; real software separates them.
                <br /><br /><b style={{ color: T.ink }}>Injector scaling</b> — <i>Injector flow rate</i> (HP Tuners), <i>K-fuel multiplier</i> (UpRev), <i>injector constant</i> elsewhere. Always the first thing you change after a fuel system upgrade.
                <br /><br />If you can say what a table <i>does</i> physically, you can find it in any software in about five minutes. That is the transferable skill.
              </ExpandableInfo>

              <ExpandableInfo title="18. A real tuning session, in order">
                This is the sequence a professional follows. It is deliberately boring, because the boring order is what stops engines being destroyed.
                <br /><br /><b style={{ color: T.ink }}>1. Verify the hardware before touching software.</b> Confirm what injectors, turbo, cam and fuel are actually fitted — not what the customer says. Check for boost and exhaust leaks. An exhaust leak upstream of the oxygen sensor makes a wideband read lean, and you will chase that error forever.
                <br /><br /><b style={{ color: T.ink }}>2. Read and save the stock file.</b> Always keep an unmodified copy you can flash back to. Every tuner has needed this.
                <br /><br /><b style={{ color: T.ink }}>3. Set scaling constants first.</b> Injector size, MAF housing, fuel pressure. These shift everything downstream, so doing them after you tune tables means redoing the tables.
                <br /><br /><b style={{ color: T.ink }}>4. Get it idling and driving, safely rich.</b> Cold start, idle, light cruise. Nothing aggressive.
                <br /><br /><b style={{ color: T.ink }}>5. Correct airflow before anything else.</b> Log, build the histogram, apply, re-log. Until the ECU knows how much air is present, every fuel and spark number you set is built on a wrong foundation.
                <br /><br /><b style={{ color: T.ink }}>6. Set the fuel targets.</b> Now that airflow is right, the commanded mixture is actually delivered.
                <br /><br /><b style={{ color: T.ink }}>7. Spark last, in small steps, on a dyno or a safe road.</b> Advance a couple of degrees, pull, check for knock, repeat. Stop when torque stops rising — that is MBT, and going past it is pure risk.
                <br /><br /><b style={{ color: T.ink }}>8. Verify across conditions.</b> Hot engine, cold engine, high gear, low gear. A tune that is only safe on a cool dyno is not finished.
              </ExpandableInfo>

              <ExpandableInfo title="19. Reading a real log — it is messier than this one">
                The datalog in this app is clean because the simulation is deterministic. A real log is not, and knowing the difference matters:
                <br /><br /><b style={{ color: T.ink }}>Only trust steady-state cells.</b> During a fast transient the fuel film on the port walls and the sensor lag mean the wideband is reporting something that happened a moment ago. Professional software lets you filter for stable conditions; use it, and discard cells the engine only touched briefly.
                <br /><br /><b style={{ color: T.ink }}>Widebands lag.</b> Typically 100–200 ms including transport time down the pipe. At 6000 RPM that is many combustion events. Align your log or accept the smear.
                <br /><br /><b style={{ color: T.ink }}>Widebands lie when the exhaust leaks.</b> Any air drawn in ahead of the sensor reads as lean. If a correction seems impossibly large, suspect the plumbing before the calibration.
                <br /><br /><b style={{ color: T.ink }}>Knock sensors hear other things.</b> Injector noise, valvetrain rattle and drivetrain clunks can all register as knock, particularly at high RPM. Real tuners correlate with an audio knock detector before pulling timing, rather than trusting the count blindly.
                <br /><br /><b style={{ color: T.ink }}>One clean pull beats five rushed ones.</b> Let the engine cool between runs, watch coolant and intake temperatures, and stop if anything moves the wrong way.
              </ExpandableInfo>

              <ExpandableInfo title="20. What this simulator cannot teach you">
                Being straight with you, because a false sense of readiness is genuinely dangerous around engines.
                <br /><br />This app can give you the mental model: what the ECU calculates, why each table exists, how a change propagates to torque, and the diagnostic habit of reading a log before touching a number. That transfers completely and it is most of the theory.
                <br /><br />It cannot give you: the feel of a real dyno session, the sound of genuine detonation (a sharp metallic rattle you learn by hearing it next to someone experienced), the specific quirks of any individual platform, flashing procedure and the risk of bricking an ECU, or the judgement that comes from having seen an engine let go.
                <br /><br /><b style={{ color: T.ink }}>So the honest advice:</b> use this to understand the physics thoroughly, then start on someone else's spare engine or a cheap car you can afford to lose, tune conservatively, and get a second opinion on your first few calibrations. The theory here is sound. The consequences of a mistake are not simulated.
              </ExpandableInfo>

              <div style={{ fontSize: 11, letterSpacing: 1, color: T.amberInk, fontWeight: 800, margin: '14px 0 8px' }}>PART 5 · GETTING IT TO THE GROUND</div>

              <ExpandableInfo title="21. Gearing — torque multiplication">
                An engine makes a fixed torque at a given RPM. The gearbox and final drive multiply it before it reaches the tyre:
                <br /><br /><span style={{ fontFamily: T.mono, color: T.cyan, fontSize: 11.5 }}>wheelTorque = engineTorque × gearRatio × finalDrive</span><br />
                <span style={{ fontFamily: T.mono, color: T.cyan, fontSize: 11.5 }}>tractiveForce = wheelTorque ÷ tyreRadius</span>
                <br /><br />A 3.79 first gear with a 3.54 final multiplies engine torque by <b style={{ color: T.ink }}>13.4×</b>. Nothing about the engine changed — that multiplication is why first gear lights the tyres and sixth cannot.
                <br /><br />The trade is exact and unavoidable: the same ratio divides road speed by 13.4. Gearing does not create energy, it trades force against speed. Road speed for any gear is:
                <br /><br /><span style={{ fontFamily: T.mono, color: T.cyan, fontSize: 11.5 }}>v = RPM × 2π × tyreRadius ÷ (60 × gearRatio × finalDrive)</span>
                <br /><br />Choosing ratios is really choosing where in the RPM band you spend your time. Keep the engine near peak torque as much as possible and you will beat a car with more peak power that falls out of its band on every shift.
              </ExpandableInfo>

              <ExpandableInfo title="22. Grip — the hard ceiling">
                Torque you cannot transmit is just smoke. The tyre limit is:
                <br /><br /><span style={{ fontFamily: T.mono, color: T.cyan, fontSize: 11.5 }}>F_max = μ × N</span>
                <br /><br />μ is the coefficient of friction, N the load on the driven tyres. Measured values: street tyres <b style={{ color: T.ink }}>0.8–0.9</b>, good summer tyres near <b style={{ color: T.ink }}>1.0</b>, racing slicks <b style={{ color: T.ink }}>1.7–1.9</b>, prepared drag surfaces higher again.
                <br /><br />Since F = ma, μ is directly a ceiling on acceleration in g. At μ = 0.85 you cannot exceed 0.85 g even in theory — and on a rear-drive car only about 47% of the weight sits on the driven axle at rest, so the real launch limit is far lower.
                <br /><br /><b style={{ color: T.ink }}>Weight transfer is what rescues it.</b> Under acceleration load shifts rearward:
                <br /><br /><span style={{ fontFamily: T.mono, color: T.cyan, fontSize: 11.5 }}>ΔN = m × a × h ÷ L</span>
                <br /><br />mass × acceleration × centre-of-gravity height ÷ wheelbase. Grip therefore grows with the very acceleration it enables, which is why a rear-drive car launches better than its static weight distribution suggests, and why a taller centre of gravity actually helps at the strip even though it hurts everywhere else. AWD sidesteps the whole problem by starting with all the weight already on driven wheels.
              </ExpandableInfo>

              <ExpandableInfo title="23. What actually slows the car down">
                Three forces oppose you, and they dominate at different points on the strip:
                <br /><br /><span style={{ fontFamily: T.mono, color: T.cyan, fontSize: 11.5 }}>F_aero = ½ × ρ × Cd × A × v²</span>
                <br /><br />Aerodynamic drag rises with the <b style={{ color: T.ink }}>square</b> of speed, so it is almost nothing at launch and enormous at the trap. Doubling speed quadruples drag — which is why trap speed is a far better measure of power than ET, and why ET is dominated by traction and gearing instead.
                <br /><br /><span style={{ fontFamily: T.mono, color: T.cyan, fontSize: 11.5 }}>F_roll = Crr × m × g</span>
                <br /><br />Rolling resistance is roughly constant, typically 1–1.5% of weight.
                <br /><br /><b style={{ color: T.ink }}>Rotational inertia</b> is the one people forget. The engine, flywheel, gearbox and wheels all have to be spun up as well as the car moved, so they behave like extra mass — and the effect is worst in low gears, where the engine spins fastest relative to road speed. Lighter wheels genuinely help more than the same weight removed from the boot.
                <br /><br />Everything left over is acceleration: <span style={{ fontFamily: T.mono, color: T.cyan, fontSize: 11.5 }}>a = (F_tractive − F_aero − F_roll) ÷ m_effective</span>
              </ExpandableInfo>

              <ExpandableInfo title="24. Reading a time slip">
                <b style={{ color: T.ink }}>Sixty-foot time</b> tells you about the launch — traction, gearing, and how well you left the line. It is the single biggest lever on ET for most street cars.
                <br /><br /><b style={{ color: T.ink }}>Trap speed</b> tells you about <i>power to weight</i>, because at the far end aerodynamic drag dominates and only sustained power holds speed against it. Two cars can share an ET with very different trap speeds: the one trapping faster has more power and launched worse.
                <br /><br /><b style={{ color: T.ink }}>ET is a combination.</b> Improving it means finding which part is costing you. If your trap speed is high but ET poor, the answer is grip and gearing, not more boost. If trap speed is low, you need power. The time slip tells you which — the same diagnostic habit as reading a datalog.
              </ExpandableInfo>

              <ExpandableInfo title="25. Sources — and what checking them changed">
                None of the physics here is invented, and the numbers have been checked against published sources rather than assumed. Where a source disagreed with this simulation, the simulation was changed.
                <br /><br /><b style={{ color: T.amberInk }}>MIT OpenCourseWare 8.21, The Physics of Energy, Lecture 11</b><br />
                Gives the Otto cycle efficiency as <span style={{ fontFamily: T.mono, color: T.cyan, fontSize: 11.5 }}>η = 1 − 1/r^(γ−1)</span>, and — critically — the value of γ to use: at 1500–2500 K the combustion products have <b style={{ color: T.ink }}>γ ≈ 1.3</b>, giving η ≈ 0.50 at a compression ratio near 10.
                <br /><br />This app originally used γ = 1.35. That was corrected to 1.3 to match. The textbook γ = 1.4 is the <i>cold</i>-air-standard value and would overstate efficiency by about 20% here. The lecture also states real spark-ignition engines reach 35–40% at best, which is why ideal efficiency is scaled down before it reaches the dyno.
                <br /><br /><b style={{ color: T.amberInk }}>NASA Glenn, Beginners Guide to Aeronautics</b><br />
                "Internal Combustion Engine (Otto Cycle)" and "Engine Thermodynamic Analysis" give the underlying relations <span style={{ fontFamily: T.mono, color: T.cyan, fontSize: 11.5 }}>T₃/T₂ = r^(γ−1)</span> and <span style={{ fontFamily: T.mono, color: T.cyan, fontSize: 11.5 }}>p₃/p₂ = r^γ</span> that the efficiency formula derives from.
                <br /><br /><b style={{ color: T.amberInk }}>x-engineer.org, Internal Combustion Engines</b><br />
                Confirms the foundation the whole model rests on: one engine cycle is <b style={{ color: T.ink }}>two complete crankshaft rotations (720°)</b>, and only the power stroke produces energy — intake, compression and exhaust all consume it. That is exactly what the <span style={{ fontFamily: T.mono, color: T.cyan, fontSize: 11.5 }}>120000 ÷ RPM</span> injector cycle time and the <span style={{ fontFamily: T.mono, color: T.cyan, fontSize: 11.5 }}>÷ 4π</span> in the torque equation encode, and why pumping loss is subtracted rather than ignored.
                <br /><br /><b style={{ color: T.amberInk }}>Other figures cross-checked</b><br />
                Stoichiometric gasoline ≈ 14.7:1 (MIT) — matches. Slightly rich giving a small power increase (MIT) — matches the best-power target near λ0.87. Compression limited to about 10:1 by knock on pump fuel (MIT) — matches the knock model's behaviour. Part-throttle running at roughly 0.5 atm intake pressure raising pumping loss (MIT) — matches the load rows and the rise in fuel consumption at light load.
                <br /><br /><b style={{ color: T.amberInk }}>Hot Rod, "Basic Engine Physics &amp; Math"</b><br />
                Listed as further reading for the same arithmetic worked longhand. Its specific figures have not been individually cross-checked here.
                <br /><br />Every formula was also verified for dimensional consistency: air density resolves to 1.185 kg/m³ at sea level and 25°C against a 1.184 reference, and injector cycle time derives exactly from two crank revolutions.
                <br /><br />If a figure in this app looks wrong to you, check it against these rather than taking it on trust. That is the correct instinct, and it has already caught several real errors here — including the γ value above.
              </ExpandableInfo>

              <ExpandableInfo title="26. Habits that keep engines alive">
                Target zero knock, not "acceptable" knock. Stay on the rich side of best power until you have confirmed margin. Never chase a number you have not measured. When something looks wrong, find the cause rather than compensating for it downstream — a MAF error corrected by bending the AFR table will be wrong again the moment load changes.
                <br /><br />And watch engine health on HOME. Damage here accumulates the way it does in reality: a few destructive pulls, not one dramatic failure.
              </ExpandableInfo>

            </BuildSection>
          </div>
        )}

        {/* ---------- BUILD: engine architecture, parts, forced induction ---------- */}
        {tab === 'build' && (
          <div style={{ padding: 16 }}>
            {journeyStep === 0 && <JourneyBanner step={0} onAdvance={() => { setJourneyStep(1); changeTab('tune'); }} onDismiss={() => setJourneyStep(99)} />}
            <Eyebrow icon={Settings}>Garage</Eyebrow>
            <p style={{ fontSize: 12.5, color: T.ink2, lineHeight: 1.6, marginTop: 0, marginBottom: 14 }}>
              Design the car before you tune it. Tap a section to open it — every choice inside changes real physics elsewhere in the sandbox.
            </p>

            <BuildSection
              active={buildSection === 'engine'} onClick={() => setBuildSection(buildSection === 'engine' ? null : 'engine')}
              icon={Settings} label="Engine Architecture"
              sub={`${engineDerived.displacementL.toFixed(1)}L ${engineConfig.configuration} · ${engineConfig.compression.toFixed(1)}:1 · ${engineConfig.camDuration}° cam`}
            >
              <Panel tight style={{ marginBottom: 13 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: T.ink2, marginBottom: 5, fontWeight: 600 }}><span>DISPLACEMENT</span><span style={{ color: T.ink, fontWeight: 800, fontFamily: T.mono }}>{engineDerived.displacementL.toFixed(2)} L</span></div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: T.ink2, marginBottom: 5, fontWeight: 600 }}><span>BORE : STROKE</span><span style={{ color: T.ink, fontWeight: 800, fontFamily: T.mono }}>{engineDerived.ratio.toFixed(3)}</span></div>
                <div style={{ fontSize: 11.5, color: T.amberInk, fontWeight: 600 }}>{engineDerived.character}</div>
              </Panel>

              {!veAdvice.inSync && (
                <div style={{ background: T.panel2, border: `1px solid ${T.amber}`, borderRadius: 10, padding: '11px 13px', margin: '4px 0 10px', fontSize: 12, color: '#a5aebb', lineHeight: 1.5 }}>
                  <b style={{ color: T.amberInk }}>Your VE table is now stale.</b> This hardware breathes differently than what you last logged — up to {veAdvice.maxAbs.toFixed(0)}% off. Head to <b style={{ color: T.ink }}>TUNE &rsaquo; AIR</b> to see which cells changed and why, then accept it there.
                </div>
              )}
              <ExpandableInfo title="Why changing hardware does not update your VE table">
                Everything that physically changes how this engine breathes feeds volumetric efficiency: bore/stroke ratio, cylinder count, compression, cam duration, valve springs, head material, intake/headers/exhaust, pipe diameter, turbine backpressure, even fuel choice (E85 evaporates cold enough to measurably densify the charge).
                <br /><br />But your VE table is a <b style={{ color: T.ink }}>log</b> — a record of what the engine actually flowed last time it was measured. Bolt on a cam and that log does not rewrite itself; it just becomes wrong. In a real shop you would go back to the dyno and re-log airflow before trusting any of it.
                <br /><br />So this app never edits it silently. It tells you what changed, by how much, and in which RPM range — and lets you accept it once you understand why it moved.
                <br /><br />Note that <b style={{ color: T.ink }}>boost is not part of VE</b>. VE measures how well the cylinder fills relative to the pressure available; boost raises that pressure (MAP) separately. That is why adding boost does not change these numbers, but adding a turbine does — the turbine is a restriction in the exhaust.
              </ExpandableInfo>

              <div style={{ fontSize: 12, color: T.ink2, marginBottom: 6, marginTop: 10, fontWeight: 600 }}>Configuration</div>
              <Seg options={CONFIG_OPTS.map((c) => ({ label: `${c} · ${CYL_COUNT[c]}cyl`, value: c }))} value={engineConfig.configuration} onChange={(v) => setCfg({ configuration: v })} />
              <ExpandableInfo title="Why cylinder count and layout matter">
                For the same total displacement, spreading it across more, smaller cylinders means each one needs less peak pressure to make the same overall torque — a small real knock-margin benefit and smoother delivery. More cylinders also means more bearings and friction, so it is a trade-off, not a free upgrade.
              </ExpandableInfo>

              <div style={{ fontSize: 12, color: T.ink2, margin: '10px 0 6px', fontWeight: 600 }}>Bore: {engineConfig.bore.toFixed(1)} mm</div>
              <input type="range" min={75} max={105} step={0.5} value={engineConfig.bore} onChange={(e) => setCfg({ bore: Number(e.target.value) })} style={{ width: '100%', accentColor: T.amber }} />
              <div style={{ fontSize: 12, color: T.ink2, margin: '10px 0 6px', fontWeight: 600 }}>Stroke: {engineConfig.stroke.toFixed(1)} mm</div>
              <input type="range" min={65} max={100} step={0.5} value={engineConfig.stroke} onChange={(e) => setCfg({ stroke: Number(e.target.value) })} style={{ width: '100%', accentColor: T.amber }} />
              <ExpandableInfo title="Bore, stroke, and engine character">
                Bore is cylinder diameter, stroke is how far the piston travels; together with cylinder count they set displacement. But the ratio between them shapes character independent of displacement: big-bore/short-stroke ("oversquare") tends to breathe and rev higher; small-bore/long-stroke ("undersquare") tends toward stronger low-end torque. This sandbox shifts your VE curve's effective bias toward high or low RPM based on what you set here.
              </ExpandableInfo>

              <div style={{ fontSize: 12, color: T.ink2, margin: '10px 0 6px', fontWeight: 600 }}>Compression Ratio: {engineConfig.compression.toFixed(1)}:1</div>
              <input type="range" min={8.5} max={13.0} step={0.1} value={engineConfig.compression} onChange={(e) => setCfg({ compression: Number(e.target.value) })} style={{ width: '100%', accentColor: T.amber }} />
              <ExpandableInfo title="Compression ratio's trade-off">
                Higher compression squeezes the mixture tighter before ignition, extracting more work from the same fuel — genuinely more efficient and torquey. The same squeeze also raises end-gas temperature and pressure, which is what causes knock. That is exactly why turbocharged engines usually run lower static compression than naturally aspirated ones: boost already adds cylinder pressure on its own.
              </ExpandableInfo>

              <div style={{ fontSize: 12, color: T.ink2, margin: '10px 0 6px', fontWeight: 600 }}>
                Camshaft Duration: {engineConfig.camDuration}° <span style={{ color: T.ink3, fontWeight: 400 }}>· overlap {Math.round(engineDerived.overlapDeg)}°</span>
              </div>
              <input type="range" min={180} max={300} step={2} value={engineConfig.camDuration} onChange={(e) => setCfg({ camDuration: Number(e.target.value) })} style={{ width: '100%', accentColor: T.amber }} />
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9.5, color: T.ink3, marginTop: 2 }}>
                <span>mild · low-end torque</span><span>wild · top-end power</span>
              </div>
              <ExpandableInfo title="What camshaft duration actually does">
                Duration is how long, in crank degrees, a valve stays open. Hold the intake valve open longer and at <b style={{ color: T.ink }}>low RPM</b> some charge gets pushed back out during compression — you lose bottom end. But at <b style={{ color: T.ink }}>high RPM</b> there is barely time to fill the cylinder at all, and that extra open time is exactly what keeps it breathing.
                <br /><br />So a bigger cam does not add power everywhere — it <i>moves</i> the power. Watch the VE table and the dyno curve: the peak slides up the RPM range and the low-RPM cells drop. This sandbox models it by sampling the breathing curve at a cam-shifted engine speed, which is the honest way to represent it.
                <br /><br /><b style={{ color: T.ink }}>Overlap</b> is the window where both valves are open together. It grows with duration, and it is why cammed engines idle lumpy, pull weak manifold vacuum, and sound the way they do.
              </ExpandableInfo>

              <div style={{ fontSize: 12, color: T.ink2, margin: '10px 0 6px', fontWeight: 600 }}>
                Valve Spring Rate: {engineConfig.springRate} <span style={{ color: engineDerived.floatRpm < 7500 ? T.red : T.ink3, fontWeight: 400 }}>· float at {Math.round(engineDerived.floatRpm)} RPM</span>
              </div>
              <input type="range" min={20} max={100} step={1} value={engineConfig.springRate} onChange={(e) => setCfg({ springRate: Number(e.target.value) })} style={{ width: '100%', accentColor: engineDerived.floatRpm < 7500 ? T.red : T.cyan }} />
              {engineDerived.floatRpm < 7500 && (
                <div style={{ fontSize: 11.5, color: T.red, marginTop: 5 }}>
                  Springs float below redline — cylinder filling collapses above {Math.round(engineDerived.floatRpm)} RPM. Stiffen them or fit a milder cam.
                </div>
              )}
              <ExpandableInfo title="Why springs decide how far a cam can go">
                The cam pushes the valve open; only the spring closes it. As RPM rises the valve has less and less time to follow the closing ramp, and past the spring's limit it stops following the lobe entirely — <b style={{ color: T.ink }}>valve float</b>. The cylinder cannot fill, and power falls off a cliff rather than tapering.
                <br /><br />Bigger cams open valves further and faster, so they need stiffer springs. That is why "cam and springs" are sold together: fit an aggressive cam on stock springs and you will make <i>less</i> power than stock up top, because you float before you reach the RPM the cam was designed for.
                <br /><br />Stiffness is not free either — every cycle the engine compresses those springs, and that parasitic loss shows up in FMEP. Over-spring a mild cam and you simply lose a little power for nothing.
              </ExpandableInfo>

              <div style={{ fontSize: 12, color: T.ink2, marginBottom: 6, fontWeight: 600 }}>Block Material</div>
              <Seg options={MATERIAL_OPTS.map((m) => ({ label: m, value: m }))} value={engineConfig.blockMaterial} onChange={(v) => setCfg({ blockMaterial: v })} />
              <div style={{ fontSize: 12, color: T.ink2, margin: '10px 0 6px', fontWeight: 600 }}>Head Material</div>
              <Seg options={MATERIAL_OPTS.map((m) => ({ label: m, value: m }))} value={engineConfig.headMaterial} onChange={(v) => setCfg({ headMaterial: v })} />
              <ExpandableInfo title="Why block and head material matter">
                Aluminum conducts heat roughly three times faster than cast iron, so an aluminum head pulls heat away from the combustion chamber faster — a real, measurable knock-margin benefit. Cast iron is heavier and a worse conductor, but stiffer under heat, which is part of why some high-output blocks still use it.
              </ExpandableInfo>
              <Note>Changing bore, stroke, or configuration does not retroactively rewrite your VE/timing/AFR tables — you will feel the shift on your next dyno pull and can re-tune from there, just like swapping a real short block.</Note>
            </BuildSection>

            <BuildSection
              active={buildSection === 'boltons'} onClick={() => setBuildSection(buildSection === 'boltons' ? null : 'boltons')}
              icon={Package} label="Bolt-On Parts"
              sub={`${Object.values(mods).filter((v) => v).length}/4 installed`}
            >
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 9 }}>
                <button onClick={resetToStock} style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'none', border: 'none', color: T.ink2, fontSize: 11, fontWeight: 600 }}>
                  <RotateCcw size={12} /> RESET ALL TO STOCK
                </button>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {Object.keys(MOD_INFO).map((key) => (
                  <button key={key} onClick={() => installMod(key)} disabled={mods[key]} style={{
                    textAlign: 'left', padding: '11px 13px', borderRadius: 10,
                    border: `1px solid ${mods[key] ? '#1f4a30' : T.line}`,
                    background: mods[key] ? T.greenBg : T.panel2,
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontWeight: 700, fontSize: 13, color: mods[key] ? T.green : T.ink }}>{MOD_INFO[key].label}</span>
                      <span style={{ fontSize: 10.5, fontWeight: 800, color: mods[key] ? T.green : T.amberInk }}>{mods[key] ? 'INSTALLED' : 'INSTALL'}</span>
                    </div>
                    <div style={{ fontSize: 11.5, color: T.ink2, marginTop: 3 }}>{MOD_INFO[key].blurb}</div>
                  </button>
                ))}
              </div>

            </BuildSection>

            <BuildSection
              active={buildSection === 'turbo'} onClick={() => setBuildSection(buildSection === 'turbo' ? null : 'turbo')}
              icon={Wind} label="Forced Induction"
              sub={turboOn ? `On · ${TURBINE_OPTS[turbineIdx].label.split(' ')[0]} turbine · peak ${Math.max(...boostCurve)} psi` : 'Not installed'}
            >
              <ToggleRow label="Turbo kit" sub="Adds boost near WOT, with spool lag off idle" checked={turboOn} onChange={setTurboOn} />

              <div style={{ maxHeight: turboOn ? 3000 : 0, opacity: turboOn ? 1 : 0, overflow: 'hidden', transition: 'max-height .4s ease, opacity .3s ease' }}>
                <div style={{ paddingTop: 12 }}>
                  <div style={{ fontSize: 12, color: T.ink2, marginBottom: 6, fontWeight: 600 }}>Turbine Size</div>
                  <PickList options={TURBINE_OPTS.map((o) => ({ label: o.label, value: o.label }))} value={TURBINE_OPTS[turbineIdx].label} onChange={(v) => setTurbineIdx(TURBINE_OPTS.findIndex((o) => o.label === v))} />
                  <div style={{ fontSize: 12, color: T.ink2, marginBottom: 6, marginTop: 4, fontWeight: 600 }}>Compressor Size</div>
                  <Seg options={COMPRESSOR_OPTS.map((o) => ({ label: o.label, value: o.label }))} value={COMPRESSOR_OPTS[compressorIdx].label} onChange={(v) => setCompressorIdx(COMPRESSOR_OPTS.findIndex((o) => o.label === v))} />
                  <div style={{ fontSize: 11, color: T.ink3, marginBottom: 10, marginTop: 4 }}>Ceiling before it runs outside its efficient range: ~{COMPRESSOR_OPTS[compressorIdx].boostCeiling} psi</div>
                  <ExpandableInfo title="Turbine vs. compressor — different jobs">
                    The turbine sits in the exhaust and spins from exhaust energy — its size sets how quickly it spools (small = fast but chokes exhaust flow up top; large = laggy but flows more at redline). The compressor sits in the intake and does the actual pressurizing — its size sets a practical boost ceiling before it's forced outside its efficient operating range, making hot, inefficient, knock-prone air.
                    <br /><br />Real turbo shops size compressors by required <b style={{ color: T.ink }}>airflow</b>, not boost pressure. The industry rule of thumb is about <b style={{ color: T.ink }}>10 crank horsepower per lb/min of air</b> (roughly 8.5 whp after drivetrain loss) — so a 400 whp target needs a compressor good for roughly 47 lb/min, which you then check against the manufacturer's compressor map.
                    <br /><br />Note that this figure barely changes with fuel. E85 needs far more fuel by volume, but it also releases almost exactly the same energy per unit of <i>air</i> as gasoline, so airflow — not fuel type — sets the power ceiling. Octane still helps, but through better timing, not through a bigger number here.
                  </ExpandableInfo>

                  <div style={{ marginTop: 4, marginBottom: 14 }}>
                    <ToggleRow label="Intercooler" sub="Cools charge air, buys knock margin under boost" checked={mods.intercooler} onChange={(v) => setMods((m) => ({ ...m, intercooler: v }))} color={T.cyan} />
                  </div>

                  <div style={{ fontSize: 12, color: T.ink2, marginBottom: 8, fontWeight: 600 }}>Boost Target Curve</div>

                  <Panel tight style={{ marginBottom: 10 }}>
                    {/* Tap a bar to select that RPM point, then edit it below with full-width controls. */}
                    <div style={{ display: 'flex', gap: 3, alignItems: 'flex-end', height: 104 }}>
                      {RPM.map((r, i) => {
                        const on = boostSel === i;
                        const ceiling = COMPRESSOR_OPTS[compressorIdx].boostCeiling;
                        const over = boostCurve[i] > ceiling;
                        return (
                          <button key={r} onClick={() => setBoostSel(i)} style={{
                            flex: 1, height: '100%', padding: 0, borderRadius: 7,
                            border: `1px solid ${on ? T.amber : T.line}`,
                            background: on ? T.amberBg : T.panel,
                            display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', overflow: 'hidden',
                          }}>
                            <div style={{ fontSize: 10, fontFamily: T.mono, fontWeight: 800, color: over ? T.red : on ? T.amberInk : T.ink2, paddingBottom: 2 }}>
                              {boostCurve[i]}
                            </div>
                            <div style={{
                              height: `${(boostCurve[i] / 25) * 72}%`, minHeight: boostCurve[i] > 0 ? 3 : 0,
                              background: over ? T.red : on ? T.amber : '#7a4526',
                              borderRadius: '3px 3px 0 0', transition: 'height .12s',
                            }} />
                            <div style={{ fontSize: 8, color: on ? T.amberInk : T.ink3, fontFamily: T.mono, padding: '3px 0' }}>
                              {r >= 1000 ? (r / 1000).toFixed(1) + 'k' : r}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </Panel>

                  <Panel tight style={{ marginBottom: 10 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
                      <span style={{ fontSize: 10.5, letterSpacing: 1, color: T.ink2, fontWeight: 700 }}>{RPM[boostSel]} RPM</span>
                      <span style={{ fontFamily: T.mono, fontSize: 24, fontWeight: 800, color: boostCurve[boostSel] > COMPRESSOR_OPTS[compressorIdx].boostCeiling ? T.red : T.amberInk }}>
                        {boostCurve[boostSel]}<span style={{ fontSize: 12, color: T.ink2, marginLeft: 3 }}>psi</span>
                      </span>
                    </div>
                    <input type="range" min={0} max={25} step={1} value={boostCurve[boostSel]}
                      onChange={(e) => { const n = [...boostCurve]; n[boostSel] = Number(e.target.value); setBoostCurve(n); }}
                      style={{ width: '100%', accentColor: T.amber }} />
                    <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                      {[-5, -1, 1, 5].map((d) => (
                        <button key={d} onClick={() => { const n = [...boostCurve]; n[boostSel] = clamp(n[boostSel] + d, 0, 25); setBoostCurve(n); }}
                          style={{ flex: 1, padding: '11px 0', borderRadius: 8, border: `1px solid ${T.line}`, background: T.panel,
                            color: d < 0 ? '#ff9d7a' : T.green, fontWeight: 800, fontFamily: T.mono, fontSize: 14 }}>
                          {d > 0 ? '+' : ''}{d}
                        </button>
                      ))}
                    </div>
                    <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                      <button onClick={() => setBoostCurve(boostCurve.map(() => boostCurve[boostSel]))}
                        style={{ flex: 1, padding: '9px 0', borderRadius: 8, border: `1px solid ${T.line}`, background: T.panel, color: T.ink2, fontWeight: 700, fontSize: 11 }}>
                        FLAT ACROSS ALL
                      </button>
                      <button onClick={() => { const peak = boostCurve[boostSel]; setBoostCurve(RPM.map((r) => Math.round(peak * clamp((r - 1500) / 2600, 0, 1)))); }}
                        style={{ flex: 1, padding: '9px 0', borderRadius: 8, border: `1px solid ${T.line}`, background: T.panel, color: T.ink2, fontWeight: 700, fontSize: 11 }}>
                        SPOOL RAMP
                      </button>
                      <button onClick={() => setBoostCurve([0, 0, 0, 0, 0, 0, 0])}
                        style={{ flex: 1, padding: '9px 0', borderRadius: 8, border: `1px solid ${T.line}`, background: T.panel, color: T.ink2, fontWeight: 700, fontSize: 11 }}>
                        ZERO
                      </button>
                    </div>
                    <div style={{ fontSize: 10.5, color: Math.max(...boostCurve) > COMPRESSOR_OPTS[compressorIdx].boostCeiling ? T.red : T.ink3, marginTop: 8 }}>
                      Compressor efficient to ~{COMPRESSOR_OPTS[compressorIdx].boostCeiling} psi{Math.max(...boostCurve) > COMPRESSOR_OPTS[compressorIdx].boostCeiling ? ' — you are past it, expect hot inefficient air' : ''}
                    </div>
                  </Panel>

                  <Note tone="warn">Stock calibrations have no real tuning above ~101 kPa. Adding boost without retarding SPARK and richening FUEL in the high-MAP rows will knock hard — run a pull and read the log.</Note>

                  <ExpandableInfo title="Why boost costs you timing">
                    Boost packs more air and fuel into the same cylinder volume before combustion starts, raising peak pressure and temperature for a given amount of spark advance. The same timing that was safe with no boost becomes knock-prone at 8-10 psi through the same head and pistons — which is why boosted tunes run less initial timing than a naturally aspirated tune, and why timing has to come out further as boost climbs. Set your target here, then dial in TIMING and AFR to match.
                  </ExpandableInfo>
                </div>
              </div>
            </BuildSection>

            <BuildSection
              active={buildSection === 'exhaust'} onClick={() => setBuildSection(buildSection === 'exhaust' ? null : 'exhaust')}
              icon={Flame} label="Exhaust"
              sub={EXHAUST_DIA_OPTS[exhaustDiaIdx].label}
            >
              <div style={{ fontSize: 12, color: T.ink2, marginBottom: 6, fontWeight: 600 }}>Exhaust Diameter</div>
              <Seg options={EXHAUST_DIA_OPTS.map((o) => ({ label: o.label, value: o.label }))} value={EXHAUST_DIA_OPTS[exhaustDiaIdx].label} onChange={(v) => setExhaustDiaIdx(EXHAUST_DIA_OPTS.findIndex((o) => o.label === v))} />
              <div style={{ fontSize: 11, color: T.ink3, marginBottom: 4 }}>
                Estimated ideal for this build: ~{idealExhaustDia.toFixed(2)} in
                {turboOn && Math.max(...boostCurve) > 0 && <span style={{ color: T.amberInk }}> (raised by boost)</span>}
              </div>
              <ExpandableInfo title="Why exhaust diameter isn't just 'bigger is better'">
                Undersized piping restricts flow at high RPM, choking VE right when the engine wants air moving fastest. Oversized piping does the opposite at low RPM — exhaust velocity drops, scavenging gets lazy, and low-end response suffers.
                <br /><br />The long-standing shop rule is about <b style={{ color: T.ink }}>one inch of total pipe diameter per 100 crank horsepower</b>. Note that this follows POWER, not just engine size — which is why adding boost raises the ideal diameter for the very same engine. This sandbox estimates that target from your displacement and boost, and shows how far your choice sits from it.
              </ExpandableInfo>
            </BuildSection>
          </div>
        )}

        {/* ---------- TUNE: sub-view switcher for the calibration tables ---------- */}
        {tab === 'tune' && (
          <div style={{ display: 'flex', gap: 6, padding: '14px 16px 0' }}>
            {TUNE_VIEWS.map((v) => {
              const on = tuneView === v.id;
              const Icon = v.icon;
              return (
                <button key={v.id} onClick={() => { setTuneView(v.id); setSelection(null); }} style={{
                  flex: 1, padding: '10px 0 9px', borderRadius: 10, display: 'flex', flexDirection: 'column',
                  alignItems: 'center', gap: 4, fontWeight: 800, fontSize: 10, letterSpacing: 0.4,
                  border: `1px solid ${on ? T.amber : T.line}`, background: on ? T.amberBg : T.panel2,
                  color: on ? T.amberInk : T.ink2,
                }}>
                  <Icon size={15} />{v.label}
                </button>
              );
            })}
          </div>
        )}

        {tab === 'tune' && journeyStep === 1 && (
          <div style={{ padding: '14px 16px 0' }}>
            <JourneyBanner step={1} onAdvance={() => { setJourneyStep(2); changeTab('live'); }} onDismiss={() => setJourneyStep(99)} />
          </div>
        )}

        {tab === 'tune' && tuneView === 've' && (
          <>
            <div style={{ padding: '16px 16px 0' }}>
              <Eyebrow icon={Grid3x3}>Volumetric Efficiency</Eyebrow>
              <div style={{ fontSize: 12.5, color: T.ink2, marginBottom: 12, lineHeight: 1.5 }}>How completely the cylinder fills at each engine speed and load. Rows are manifold pressure (MAP kPa &mdash; about 100 is wide open, higher is boost); columns are RPM. Tap any cell for reference data.</div>
              <SelectModeBar />
              <TuningGrid data={ve} setData={setVe} min={10} max={130} decimals={0} {...gridProps} />

              {veAdvice && (
                veAdvice.inSync ? (
                  <div style={{ display: 'flex', gap: 8, background: T.greenBg, border: '1px solid #1f4a30', borderRadius: 10, padding: '11px 13px', margin: '10px 0', fontSize: 12.5, color: T.green, lineHeight: 1.5 }}>
                    <Info size={15} style={{ flexShrink: 0, marginTop: 1 }} />
                    <div>VE table matches your current hardware. Nothing to correct.</div>
                  </div>
                ) : (
                  <div style={{ background: T.panel2, border: `1px solid ${T.amber}`, borderRadius: 10, padding: '12px 13px', margin: '10px 0' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                      <div style={{ fontSize: 10, letterSpacing: 1, color: T.amberInk, fontWeight: 800 }}>VE OUT OF SYNC WITH HARDWARE</div>
                      <div style={{ fontSize: 11, fontFamily: T.mono, color: T.amberInk, fontWeight: 700 }}>{veAdvice.maxAbs.toFixed(0)}% max gap</div>
                    </div>
                    <div style={{ fontSize: 12, color: '#a5aebb', lineHeight: 1.55, marginBottom: 9 }}>
                      Your hardware changed but this table is still the old log. Here is what re-logging airflow on the dyno would actually show:
                    </div>
                    {veAdvice.recs.map((r, i) => (
                      <div key={i} style={{ marginBottom: 9 }}>
                        <div style={{ fontSize: 12, color: T.ink, fontWeight: 700 }}>{r.rpmText}</div>
                        <div style={{ fontSize: 11.5, color: '#a5aebb', lineHeight: 1.5, marginTop: 2 }}>{r.text}</div>
                        <div style={{ fontSize: 10.5, color: T.cyan, fontFamily: T.mono, marginTop: 3 }}>{r.cells.join('   ')}</div>
                      </div>
                    ))}
                    <button onClick={recalcVE} style={{ width: '100%', marginTop: 4, padding: '11px 0', borderRadius: 9, border: 'none', background: T.amber, color: '#1a0f08', fontWeight: 800, fontSize: 12.5 }}>
                      ACCEPT RE-LOGGED VALUES
                    </button>
                    <div style={{ fontSize: 10.5, color: T.ink3, textAlign: 'center', marginTop: 6 }}>Or type them in yourself — these are the measured targets, not a suggestion.</div>
                  </div>
                )
              )}

              <ExpandableInfo title="What VE actually means">
                VE compares the air trapped in the cylinder to the theoretical maximum the swept volume could hold. It rises with RPM as intake tuning matches resonance, then falls as the valves cannot flow fast enough — that fall is why every N/A engine has a torque peak. More air here means more fuel needed to hit a given AFR and more potential torque; VE is really the master variable, and timing/AFR are how you extract power from whatever air is already there.
                <br /><br /><b style={{ color: T.ink }}>As a beginner:</b> leave VE alone at first. It is set by real hardware (intake, heads, cams) — the Bolt-Ons on BUILD already move it for you when you install parts. Spend your early pulls learning TIMING and AFR before you start hand-editing VE.
              </ExpandableInfo>
            </div>
            <div style={{ flex: 1 }} />
            <SelectionDock data={ve} setData={setVe} selection={selection} min={10} max={130} decimals={0} unit="%" onClose={() => setSelection(null)} kind="ve" turboOn={turboOn} />
          </>
        )}

        {tab === 'tune' && tuneView === 'timing' && (
          <>
            <div style={{ padding: '16px 16px 0' }}>
              <Eyebrow icon={Zap}>Ignition Timing</Eyebrow>
              <div style={{ fontSize: 12.5, color: T.ink2, marginBottom: 12 }}>Degrees of spark advance before top dead center (° BTDC).</div>
              <SelectModeBar />
              <TuningGrid data={timing} setData={setTiming} min={-5} max={50} decimals={0} {...gridProps} />
              {!turboOn && (
                <div style={{ fontSize: 11, color: T.ink3, marginTop: 6 }}>
                  Rows above ~101 kPa are hidden — a naturally aspirated engine cannot reach them. Fit a turbo on BUILD and they appear.
                </div>
              )}
              {calAdvice.overAdvanced.length > 0 ? (
                <div style={{ background: T.redBg, border: `1px solid #3a2020`, borderRadius: 10, padding: '12px 13px', margin: '10px 0' }}>
                  <div style={{ fontSize: 10, letterSpacing: 1, color: '#ff9d9d', fontWeight: 800, marginBottom: 7 }}>
                    {calAdvice.overAdvanced.length} CELLS BEYOND THE KNOCK LIMIT
                  </div>
                  <div style={{ fontSize: 12, color: '#a5aebb', lineHeight: 1.55, marginBottom: 8 }}>
                    Your current hardware will not tolerate this much advance here. These cells are asking for more timing than the charge, octane and compression allow:
                  </div>
                  {calAdvice.overAdvanced.slice(0, 5).map((c, i) => (
                    <div key={i} style={{ fontSize: 11, marginBottom: 3 }}>
                      {c.unsustainable ? (
                        <span style={{ color: '#ff9d9d' }}>
                          <span style={{ fontFamily: T.mono }}>{c.map} kPa / {c.rpm} RPM:</span> no safe timing exists here — {c.cause}
                        </span>
                      ) : (
                        <span style={{ fontFamily: T.mono, color: T.cyan }}>{c.map} kPa / {c.rpm} RPM: {c.current}° → {c.suggested}°</span>
                      )}
                    </div>
                  ))}
                  {calAdvice.overAdvanced.some((c) => c.unsustainable) && (
                    <div style={{ fontSize: 11.5, color: '#ffcf8a', marginTop: 7, lineHeight: 1.5 }}>
                      Where it says no safe timing exists, pulling spark will not save it. Fix the underlying cause — fuel delivery, mixture, charge temperature or boost — and the timing limit comes back on its own.
                    </div>
                  )}
                  {calAdvice.overAdvanced.length > 5 && <div style={{ fontSize: 10.5, color: T.ink3, marginTop: 3 }}>…and {calAdvice.overAdvanced.length - 5} more</div>}
                  <div style={{ fontSize: 11, color: T.ink3, marginTop: 8 }}>Edit them yourself — a calibration is yours to make, not something the app should silently rewrite.</div>
                </div>
              ) : calAdvice.underAdvanced.length > 4 ? (
                <div style={{ background: T.panel2, border: `1px solid ${T.line}`, borderRadius: 10, padding: '11px 13px', margin: '10px 0', fontSize: 12, color: '#a5aebb', lineHeight: 1.5 }}>
                  <b style={{ color: T.amberInk }}>Timing left on the table.</b> {calAdvice.underAdvanced.length} cells are more than 3° below what this build would tolerate. Safe, but you are giving away torque — advance them a little at a time and pull between each change.
                </div>
              ) : (
                <div style={{ background: T.greenBg, border: '1px solid #1f4a30', borderRadius: 10, padding: '11px 13px', margin: '10px 0', fontSize: 12.5, color: T.green }}>
                  Spark table sits within the knock limit for this hardware.
                </div>
              )}

              <ExpandableInfo title="Why the app never rewrites your spark or fuel tables">
                The VE table auto-syncs because volumetric efficiency is a <b style={{ color: T.ink }}>measurement of the hardware</b> — swap a cam and a tuner simply re-logs airflow, and the numbers are what they are.
                <br /><br />Spark and fuel are different: they are <b style={{ color: T.ink }}>your calibration</b>, a set of judgement calls about how much risk to take for how much power. A real ECU does not retune itself when you bolt on a turbo — it keeps running the old numbers into the new hardware, which is exactly how engines get hurt.
                <br /><br />So the app tells you what the hardware will now tolerate, and leaves the editing to you. That gap between "what the engine can take" and "what your table asks for" is the entire job.
              </ExpandableInfo>

              <ExpandableInfo title="Why timing has a sweet spot (MBT)">
                Combustion is not instant — the flame front takes time to burn through the mixture. Timing decides when the burn starts so peak cylinder pressure lands just after top dead center, where it does useful work. Advance too far and pressure peaks before the piston is ready, fighting the crank and risking knock; retard too far and you are burning fuel after the piston has already started down, wasting it as heat. MBT is the earliest timing that still lands the burn right — past it, more advance buys almost nothing, only risk.
                <br /><br /><b style={{ color: T.ink }}>As a beginner:</b> nudge one cell 1-2° at a time, run a pull, and read the log. If it comes back clean with no knock event, you probably still have room. If you see a knock warning, that cell is your new ceiling — back off to what the log suggests and move on.
              </ExpandableInfo>
            </div>
            <div style={{ flex: 1 }} />
            <SelectionDock data={timing} setData={setTiming} selection={selection} min={-5} max={50} decimals={0} unit="°" onClose={() => setSelection(null)} kind="timing" turboOn={turboOn} />
          </>
        )}

        {tab === 'tune' && tuneView === 'afr' && (
          <>
            <div style={{ padding: '16px 16px 0' }}>
              <Eyebrow icon={Droplets}>Air-Fuel Ratio Target</Eyebrow>
              <div style={{ fontSize: 12.5, color: T.ink2, marginBottom: 12, lineHeight: 1.5 }}>Target air:fuel ratio the ECU aims for. Divide by 14.7 to read it as lambda.</div>
              <SelectModeBar />
              <TuningGrid data={afr} setData={setAfr} min={10} max={18} decimals={1} {...gridProps} />
              {calAdvice.wrongMix.length > 0 && (
                <div style={{ background: T.panel2, border: `1px solid ${T.amber}`, borderRadius: 10, padding: '12px 13px', margin: '10px 0' }}>
                  <div style={{ fontSize: 10, letterSpacing: 1, color: T.amberInk, fontWeight: 800, marginBottom: 7 }}>
                    {calAdvice.wrongMix.length} HIGH-LOAD CELLS OFF BEST POWER
                  </div>
                  <div style={{ fontSize: 12, color: '#a5aebb', lineHeight: 1.55, marginBottom: 8 }}>
                    Best-power mixture shifts with boost — richer as cylinder pressure rises. At these points your target is off what this build wants:
                  </div>
                  {calAdvice.wrongMix.slice(0, 5).map((c, i) => (
                    <div key={i} style={{ fontSize: 11, fontFamily: T.mono, color: c.delta < 0 ? '#ff9d9d' : T.cyan, marginBottom: 2 }}>
                      {c.map} kPa / {c.rpm} RPM: {c.current}:1 → {c.suggested}:1 {c.delta < 0 ? '(richen)' : '(lean out)'}
                    </div>
                  ))}
                  {calAdvice.wrongMix.length > 5 && <div style={{ fontSize: 10.5, color: T.ink3, marginTop: 3 }}>…and {calAdvice.wrongMix.length - 5} more</div>}
                </div>
              )}

              <ExpandableInfo title="Why AFR trades power for safety">
                14.7:1 is stoichiometric — burns all the fuel and oxygen with nothing left over, great for emissions and cruise. Peak power sits richer, because the extra fuel absorbs heat as it vaporizes, cooling combustion enough to make more power before knock becomes the limit. Go leaner than that under load and you lose power and raise both knock risk and exhaust gas temperature at once — which is why lean-under-boost is especially dangerous to valves and pistons.
                <br /><br /><b style={{ color: T.ink }}>Best power is not one number.</b> Naturally aspirated engines make best torque near lambda 0.85-0.92 (about 12.5-13.5:1 on gasoline). Under boost, best power moves richer — near lambda 0.82-0.85 (about 12.0-12.5:1) — because you are deliberately buying charge cooling to hold off knock. This sandbox moves its best-power target with your boost level, so the same AFR table that was ideal naturally aspirated reads genuinely lean once you are on 8 psi.
                <br /><br /><b style={{ color: T.ink }}>Reading it in lambda:</b> lambda is AFR divided by the fuel's stoichiometric point, so lambda 0.85 means the same relative richness on any fuel. That is why tuners talk in lambda once E85 enters the picture — 12.5:1 means something completely different on E85 than on pump gas.
                <br /><br /><b style={{ color: T.ink }}>As a beginner:</b> when in doubt, go richer (a lower number), not leaner. A rich cell costs a little power; a lean cell under load is how you actually damage something.
              </ExpandableInfo>
            </div>
            <div style={{ flex: 1 }} />
            <SelectionDock data={afr} setData={setAfr} selection={selection} min={10} max={18} decimals={1} unit=":1" onClose={() => setSelection(null)} kind="afr" turboOn={turboOn} />
          </>
        )}

        {tab === 'tune' && tuneView === 'ecu' && (
          <div style={{ padding: 16 }}>
            <Eyebrow icon={Fuel}>Fuel System</Eyebrow>
            {!turboOn && <Note>Naturally aspirated — no turbo installed. Add one on <b>BUILD</b> if you want boost to tune around.</Note>}
            {turboOn && <Note>Turbo hardware and the boost target curve live on <b>BUILD</b> — this tab is fuel-side tuning: octane, injectors, and MAF/ECU.</Note>}

            <div style={{ fontSize: 12, color: T.ink2, margin: '12px 0 6px', fontWeight: 600 }}>Fuel Octane</div>
            <Seg options={OCTANE_OPTS.map((o) => ({ label: o.label, value: o.label }))} value={OCTANE_OPTS[octaneIdx].label} onChange={(v) => setOctaneIdx(OCTANE_OPTS.findIndex((o) => o.label === v))} />
            <ExpandableInfo title="What octane actually does — and what E85 costs you">
              Octane measures a fuel's resistance to auto-igniting under heat and pressure before the spark fires it — not energy content or "power." Higher octane tolerates more cylinder pressure and temperature before knock, letting a tuner run more advance or more boost safely. It does not add power on its own; it raises the ceiling for how much timing/boost you can use before knock becomes the limit.
              <br /><br /><b style={{ color: T.ink }}>E85 is not a free upgrade.</b> Its stoichiometric point is about 9.8:1, not gasoline's 14.7:1 — so hitting the same lambda takes roughly <b style={{ color: T.amberInk }}>1.43× the fuel volume</b>. Switch to E85 without upsizing injectors and you will run out of duty cycle long before you cash in that knock margin. Watch the duty preview below change the moment you select it.
              <br /><br />That trade — huge knock resistance, huge fuel demand — is exactly why serious E85 builds pair it with bigger injectors and a bigger pump, and why "just run E85" is not a shortcut around a fuel system.
            </ExpandableInfo>

            <div style={{ fontSize: 12, color: T.ink2, margin: '10px 0 6px', fontWeight: 600 }}>Fuel Injectors</div>
            <PickList options={INJECTOR_OPTS.map((o) => ({ label: o.label, value: o.label }))} value={INJECTOR_OPTS[injIdx].label} onChange={(v) => setInjIdx(INJECTOR_OPTS.findIndex((o) => o.label === v))} />
            <div style={{ fontSize: 12, color: T.ink2, margin: '12px 0 6px', fontWeight: 600 }}>
              ECU Injector Scaling <span style={{ color: T.ink3, fontWeight: 400 }}>— what the ECU thinks is fitted</span>
            </div>
            <Seg options={INJECTOR_OPTS.map((o) => ({ label: `${o.cc}`, value: o.cc }))} value={ecuInjectorCc} onChange={setEcuInjectorCc} wrap />
            {ecuInjectorCc !== injectorCc ? (
              <div style={{ background: T.redBg, border: `1px solid #3a2020`, borderRadius: 10, padding: '11px 13px', margin: '8px 0', fontSize: 12, color: '#ff9d9d', lineHeight: 1.5 }}>
                <b>Scaling mismatch.</b> Hardware is {injectorCc}cc but the ECU is calibrated for {ecuInjectorCc}cc — every pulse delivers about {((injectorCc / ecuInjectorCc) * 100).toFixed(0)}% of the intended fuel, so the engine runs {injectorCc > ecuInjectorCc ? 'far too rich' : 'dangerously lean'} everywhere.
                <button onClick={() => setEcuInjectorCc(injectorCc)} style={{ display: 'block', width: '100%', marginTop: 9, padding: '10px 0', borderRadius: 8, border: 'none', background: T.amber, color: '#1a0f08', fontWeight: 800, fontSize: 12.5 }}>
                  RESCALE ECU TO {injectorCc}cc
                </button>
              </div>
            ) : (
              <div style={{ fontSize: 11, color: T.green, margin: '6px 0 4px' }}>ECU scaling matches the fitted injectors.</div>
            )}
            <ExpandableInfo title="Injector scaling — the step everyone forgets">
              The ECU never commands "fuel" — it commands a pulse width, calculated for the injector size it has been <i>told</i> is fitted. Bolt in bigger injectors without updating that number and every pulse delivers proportionally more fuel than intended, so the engine runs rich everywhere regardless of what your AFR table says.
              <br /><br />Every real tuning platform has this constant: UpRev calls it the <b style={{ color: T.ink }}>K-fuel multiplier</b> (lower it for bigger injectors), HP Tuners calls it <b style={{ color: T.ink }}>injector flow rate</b>. It is the first thing you change after a fuel system upgrade, before touching any table.
            </ExpandableInfo>

            <ExpandableInfo title="Why injector duty cycle limits everything">
              Injectors flow a rated amount of fuel, and the ECU controls delivery by varying how long each stays open per cycle. As RPM and airflow rise, more fuel is needed in less time, and eventually the injector is open almost the whole cycle — that is duty cycle nearing 100%. Past about 90%, there is no more room to add fuel even if the AFR table calls for it, so the mixture leans out on its own regardless of what you commanded.
            </ExpandableInfo>

            <Panel tight style={{ marginTop: 6, marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ fontSize: 10, color: T.ink2, letterSpacing: 1, fontWeight: 700 }}>INJECTOR DUTY PREVIEW · WOT @ 6500 RPM</div>
                {fuel.stoich < 14 && <div style={{ fontSize: 10, color: T.amberInk, fontFamily: T.mono, fontWeight: 700 }}>{fuel.label} stoich {fuel.stoich}:1</div>}
              </div>
              <div style={{ height: 8, background: T.panel, borderRadius: 4, marginTop: 8, overflow: 'hidden', border: `1px solid ${T.line}` }}>
                <div style={{ width: `${Math.min(100, dutyPreview)}%`, height: '100%', background: dutyPreview > 90 ? T.red : dutyPreview > 75 ? T.yellow : T.green }} />
              </div>
              <div style={{ fontSize: 12, marginTop: 7, color: dutyPreview > 90 ? '#ff9d9d' : '#c3cad2' }}>
                {dutyPreview.toFixed(0)}% duty {dutyPreview > 90 ? '— undersized for this build, expect forced lean-out' : ''}
              </div>
            </Panel>

            <Eyebrow icon={Zap}>Fuel Control &amp; MAF Scaling</Eyebrow>
            <Panel style={{ marginBottom: 13 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: T.ink2, fontWeight: 700 }}>
                <span>MAF RECAL STATUS</span>
                <span style={{ color: needsMafRecal ? T.yellow : T.green, fontWeight: 800 }}>{needsMafRecal ? 'HARDWARE CHANGED' : 'STOCK — OK'}</span>
              </div>
              {needsMafRecal && (
                <div style={{ fontSize: 11.5, color: T.ink2, marginTop: 7 }}>
                  {mods.intake && turboOn ? 'Intake + turbo plumbing' : mods.intake ? 'Intake' : 'Turbo plumbing'} changed how air reads across the MAF. Dial in the scalar below, then confirm with a dyno pull.
                </div>
              )}
            </Panel>
            <div style={{ fontSize: 12, color: T.ink2, marginBottom: 7, fontWeight: 600 }}>MAF Scalar</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 6 }}>
              <input type="range" min={0.75} max={1.25} step={0.01} value={mafScalar} onChange={(e) => setMafScalar(Number(e.target.value))} style={{ flex: 1, accentColor: T.amber }} />
              <div style={{ fontFamily: T.mono, fontWeight: 800, fontSize: 15, width: 52, textAlign: 'right', color: T.ink }}>{mafScalar.toFixed(2)}</div>
            </div>
            <ExpandableInfo title="VE tuning vs. MAF tuning — platforms differ">
              This sandbox exposes a VE table because that is the clearest way to teach airflow. Real platforms split into two camps.
              <br /><br /><b style={{ color: T.ink }}>Speed-density platforms</b> (GM via HP Tuners/EFILive) index a VE table by RPM and MAP — exactly the axes here — and you tune VE directly.
              <br /><br /><b style={{ color: T.ink }}>MAF-based platforms</b> (Nissan via UpRev) barely expose VE at all. Instead you tune a <b style={{ color: T.ink }}>MAF curve indexed by sensor voltage</b>, whose values map to grams per second, plus the K-fuel multiplier and a fuel compensation table. Same physics, different control surface: on a Nissan you correct airflow by reshaping the MAF curve rather than a VE grid.
              <br /><br />Everything you learn here transfers — just expect the knobs to be named differently depending on the platform.
            </ExpandableInfo>

            <ExpandableInfo title="How MAF-based fueling actually works">
              The MAF sensor reports airflow as a voltage, using a curve calibrated for the stock intake's exact diameter. Change the housing size and the same real airflow produces a different voltage, so the ECU's load calculation is wrong even though your fuel/timing tables did not change. At part throttle, closed-loop O2 feedback quietly corrects most of this; at wide-open throttle the ECU usually runs open-loop and blind to the O2 sensor, so the error goes straight through — which is why WOT is where bad MAF scaling shows up hardest.
              <br /><br /><b style={{ color: T.ink }}>As a beginner:</b> do not guess the scalar. Install the part, run a pull, then check the AFR trace and the MAF trim log entry on DYNO — they will tell you which direction and roughly how far to move it.
            </ExpandableInfo>
            {result && (
              <Panel tight style={{ marginTop: 6 }}>
                <div style={{ fontSize: 10, color: T.ink2, letterSpacing: 1, fontWeight: 700, marginBottom: 6 }}>FUEL TRIM — LAST PULL</div>
                <ResponsiveContainer width="100%" height={150}>
                  <LineChart data={chartData} margin={{ top: 4, right: 12, left: -14, bottom: 0 }}>
                    <CartesianGrid stroke={T.line} />
                    <XAxis dataKey="rpm" stroke={T.ink3} fontSize={10} />
                    <YAxis stroke={T.ink3} fontSize={10} unit="%" />
                    <Tooltip contentStyle={{ background: T.panel2, border: `1px solid ${T.line}`, fontSize: 11 }} />
                    <Line dataKey="trimPct" name="MAF trim %" stroke={T.violet} strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </Panel>
            )}
          </div>
        )}

        {/* ---------- LIVE: the engine running in real time ---------- */}
        {tab === 'live' && (
          <div style={{ padding: 16 }}>
            {journeyStep === 2 && <JourneyBanner step={2} onAdvance={() => { setJourneyStep(3); changeTab('dyno'); }} onDismiss={() => setJourneyStep(99)} />}
            <Eyebrow icon={Flame}>Live Engine</Eyebrow>
            <div style={{ fontSize: 12.5, color: T.ink2, lineHeight: 1.55, marginBottom: 12 }}>
              Your calibration, actually running. Start it, hold the throttle, and watch the sensors and fuel trims respond the way they would on a running car.
            </div>

              <Panel style={{ background: T.panel, marginBottom: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                  <div style={{ position: 'relative', flexShrink: 0 }}>
                    <DialMark size={104} pct={clamp(live.sensedRpm / 7500, 0, 1)} live />
                    <div style={{ position: 'absolute', top: '58%', left: '50%', transform: 'translate(-50%,-50%)', textAlign: 'center' }}>
                      <div style={{ fontSize: 17, fontWeight: 800, fontFamily: T.mono, color: live.fuelCut ? T.red : T.ink }}>{Math.round(live.sensedRpm)}</div>
                      <div style={{ fontSize: 7, color: T.ink3, letterSpacing: 1, fontWeight: 700 }}>RPM</div>
                    </div>
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 11, color: T.ink2, marginBottom: 8, lineHeight: 1.5 }}>
                      {live.running
                        ? (live.rpm > 7500 ? 'Rev limiter — fuel cut to protect the engine.'
                          : live.dfco ? 'Overrun fuel cut — injectors off while coasting down. Real ECUs do this; it costs nothing to spin.'
                          : live.coolantC < 70 ? 'Warming up — the ECU is running extra fuel until it reaches temperature.'
                          : live.closedLoop ? 'Warm and in closed loop — the ECU is trimming fuel against the O2 sensor.'
                          : 'Open loop — the ECU is following your tables directly, ignoring O2 feedback.')
                        : live.cranking ? 'Starter engaged…' : 'Engine off. Start it to watch the ECU work in real time.'}
                    </div>
                    <div style={{ display: 'flex', gap: 7 }}>
                      <button onClick={live.running || live.cranking ? stopEngine : startEngine} style={{
                        flex: 1, padding: '11px 0', borderRadius: 9, border: 'none', fontWeight: 800, fontSize: 12.5,
                        background: live.running || live.cranking ? T.panel2 : T.green, color: live.running || live.cranking ? T.ink : '#06210f',
                        borderWidth: 1, borderStyle: 'solid', borderColor: live.running || live.cranking ? T.line : T.green,
                      }}>{live.running || live.cranking ? 'STOP' : 'START ENGINE'}</button>
                      <button onClick={testSound} title="Test sound" style={{
                        width: 46, padding: '11px 0', borderRadius: 9, fontWeight: 800, fontSize: 10.5,
                        border: `1px solid ${T.line}`, background: T.panel2, color: T.ink2,
                      }}>TEST</button>
                      <button onClick={() => { if (!soundOn) ensureAudio()?.ctx.resume(); setSoundOn((v) => !v); }} title="Engine sound" style={{
                        width: 46, padding: '11px 0', borderRadius: 9, fontWeight: 800, fontSize: 13,
                        border: `1px solid ${soundOn ? T.amber : T.line}`, background: soundOn ? T.amberBg : T.panel2,
                        color: soundOn ? T.amberInk : T.ink3,
                      }}>{soundOn ? '♪' : '✕'}</button>
                    </div>
                  </div>
                </div>

                <div
                  onPointerDown={(e) => { e.currentTarget.setPointerCapture?.(e.pointerId); setThrottleInput(100); throttleRef.current = 100; }}
                  onPointerUp={() => { setThrottleInput(0); throttleRef.current = 0; }}
                  onPointerCancel={() => { setThrottleInput(0); throttleRef.current = 0; }}
                  style={{
                    position: 'relative', overflow: 'hidden',
                    marginTop: 12, padding: '18px 0', borderRadius: 12, textAlign: 'center', userSelect: 'none',
                    WebkitUserSelect: 'none', WebkitTouchCallout: 'none',
                    border: `1px solid ${throttleInput > 0 ? T.amber : T.line}`,
                    background: throttleInput > 0 ? T.amberBg : T.panel2,
                    color: throttleInput > 0 ? T.amberInk : T.ink2, fontWeight: 800, fontSize: 13.5, letterSpacing: 0.5,
                    touchAction: 'none', opacity: live.running ? 1 : 0.4,
                    transition: 'background .1s, border-color .1s',
                  }}
                >
                  <div style={{
                    position: 'absolute', left: 0, top: 0, bottom: 0,
                    width: `${clamp(live.effThrottle ?? 0, 0, 100)}%`,
                    background: 'rgba(255,106,44,0.16)', transition: 'width .12s',
                  }} />
                  <span style={{ position: 'relative' }}>
                    {!live.running ? 'START THE ENGINE FIRST' : throttleInput > 0 ? 'WIDE OPEN THROTTLE' : 'PRESS AND HOLD TO REV'}
                  </span>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
                  <span style={{ fontSize: 10, color: T.ink2, fontWeight: 700, letterSpacing: 0.5 }}>VOL</span>
                  <input type="range" min={0} max={2} step={0.05} value={volume}
                    onChange={(e) => setVolume(Number(e.target.value))}
                    style={{ flex: 1, accentColor: T.amber }} />
                  <span style={{ fontFamily: T.mono, fontSize: 11, color: T.ink2, width: 34, textAlign: 'right' }}>{Math.round(volume * 100)}%</span>
                </div>

                {audioStatus && (
                  <div style={{ fontSize: 11, color: audioStatus === 'ok' ? T.green : T.yellow, marginTop: 8, lineHeight: 1.5 }}>
                    {audioStatus === 'ok'
                      ? 'Audio is running. If you heard the test beep but not the engine, turn the engine on and hold the throttle.'
                      : audioStatus === 'blocked'
                        ? 'The browser is still blocking audio — tap START or any tab, then try TEST again.'
                        : 'This browser did not provide Web Audio, so engine sound is unavailable.'}
                    <br />On iPhone, the physical ring/silent switch mutes web audio even at full volume.
                  </div>
                )}

                <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
                  <LiveGauge label="MAF" value={live.sensedMaf.toFixed(1)} unit="g/s" color={T.cyan} />
                  <LiveGauge label="MAP" value={Math.round(live.sensedMap)} unit="kPa" />
                  <LiveGauge label="IAT" value={Math.round(live.sensedIat)} unit="°C" warn={live.sensedIat > 65} />
                </div>
                <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                  <LiveGauge label="LAMBDA" value={live.sensedLambda.toFixed(2)} unit="λ" color={T.violet} />
                  <LiveGauge label="COOLANT" value={Math.round(live.sensedCoolant)} unit="°C" warn={live.sensedCoolant > 105} />
                  <LiveGauge label="TIMING" value={live.live ? live.live.timing : '—'} unit="°" color={T.yellow} warn={!!(live.live && live.live.knock)} />
                </div>
                <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                  <LiveGauge label="INJ PW" value={live.live ? live.live.pw : '—'} unit="ms" />
                  <LiveGauge label="DUTY" value={live.live ? live.live.duty : '—'} unit="%" warn={!!(live.live && live.live.duty > 90)} />
                  <LiveGauge label="IDLE AIR" value={Math.round(live.idleTrim)} unit="%" />
                  <LiveGauge label="FUEL" value={live.fuelCut ? 'CUT' : 'ON'} unit="" color={live.fuelCut ? T.yellow : T.green} />
                </div>

                <div style={{ marginTop: 12 }}>
                  <TrimBar label="SHORT TERM FUEL TRIM (STFT)" value={live.stft} />
                  <TrimBar label="LONG TERM FUEL TRIM (LTFT)" value={live.ltft} />
                </div>
              </Panel>
              <ExpandableInfo title="Why these gauges jitter">
                Every value above is a simulated sensor reading, with real noise and lag — not the exact internal number. That is what a tuner actually sees on a scan tool, and why real logs never look perfectly smooth.
              </ExpandableInfo>
            
          </div>
        )}

        {/* ---------- DRAG: put the engine in a car and run the quarter ---------- */}
        {tab === 'drag' && (
          <div style={{ padding: 16 }}>
            <Eyebrow icon={Flag}>Drag Strip</Eyebrow>
            <div style={{ fontSize: 12.5, color: T.ink2, lineHeight: 1.55, marginBottom: 12 }}>
              A torque curve is only half of acceleration. Gearing, tyre size, grip, weight transfer and aerodynamic drag decide what actually reaches the road.
            </div>

            {!result ? (
              <Note tone="warn">Run a dyno pull first — there is no torque curve to drive with until the engine has been measured.</Note>
            ) : (
              <>
                <DragStrip res={dragResult} tNow={dragT} running={dragRunning} treePhase={treePhase} bodyIdx={car.bodyIdx} />

                <button onClick={runDrag} disabled={dragRunning} style={{
                  width: '100%', padding: '15px 0', borderRadius: 12, border: 'none', marginBottom: 14,
                  background: dragRunning ? T.panel2 : T.amber, color: dragRunning ? T.ink2 : '#1a0f08',
                  fontWeight: 800, fontSize: 14, letterSpacing: 0.5,
                }}>{dragRunning ? 'RUNNING…' : 'RUN THE QUARTER MILE'}</button>

                {dragResult && !dragRunning && (
                  <Panel style={{ marginBottom: 14 }}>
                    <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
                      <StatTile label="1/4 MILE ET" value={dragResult.et.toFixed(2)} unit="s" color={T.amberInk} />
                      <StatTile label="TRAP SPEED" value={dragResult.trapMph.toFixed(1)} unit="mph" color={T.cyan} />
                    </div>
                    <div style={{ display: 'flex', gap: 10 }}>
                      <StatTile label="60 FOOT" value={dragResult.sixtyFootT ? dragResult.sixtyFootT.toFixed(2) : '—'} unit="s" color={T.violet} />
                      <StatTile label="0-60 MPH" value={dragResult.zeroToSixty ? dragResult.zeroToSixty.toFixed(2) : '—'} unit="s" />
                      <StatTile label="1/8 MILE" value={dragResult.eighthET ? dragResult.eighthET.toFixed(2) : '—'} unit="s" />
                      <StatTile label="GEARS USED" value={dragResult.topGearUsed} />
                    </div>
                    {dragResult.wheelspun && (
                      <Note tone="warn">Wheelspin off the line. The engine made more torque than the tyres could hold, and everything past the limit was wasted turning them. More grip, taller first gear, or a softer launch.</Note>
                    )}
                  </Panel>
                )}

                <BuildSection active={buildSection === 'body'} onClick={() => setBuildSection(buildSection === 'body' ? null : 'body')}
                  icon={Package} label="Car Body" sub={`${CAR_BODIES[car.bodyIdx].label} · ${CAR_BODIES[car.bodyIdx].massKg} kg · Cd ${CAR_BODIES[car.bodyIdx].cd.toFixed(2)}`}>
                  <Seg options={CAR_BODIES.map((b, i) => ({ label: b.label, value: i }))}
                    value={car.bodyIdx}
                    onChange={(i) => setCar({ ...car, bodyIdx: i, ...CAR_BODIES[i] })} wrap />
                  <div style={{ fontSize: 11.5, color: T.ink3, marginTop: 6, lineHeight: 1.5 }}>{CAR_BODIES[car.bodyIdx].note}</div>

                  <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                    <StatTile label="MASS" value={CAR_BODIES[car.bodyIdx].massKg} unit="kg" />
                    <StatTile label="Cd" value={CAR_BODIES[car.bodyIdx].cd.toFixed(2)} />
                    <StatTile label="FRONTAL" value={CAR_BODIES[car.bodyIdx].frontalAreaM2.toFixed(2)} unit="m²" />
                  </div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                    <StatTile label="CG HEIGHT" value={CAR_BODIES[car.bodyIdx].cgHeightM.toFixed(2)} unit="m" />
                    <StatTile label="WHEELBASE" value={CAR_BODIES[car.bodyIdx].wheelbaseM.toFixed(2)} unit="m" />
                    <StatTile label="REAR WEIGHT" value={Math.round(CAR_BODIES[car.bodyIdx].rearFrac * 100)} unit="%" />
                  </div>

                  <ExpandableInfo title="Why the same engine is not the same car">
                    Nothing here is a handicap number — every figure is a term in the equations already running.
                    <br /><br /><b style={{ color: T.ink }}>Mass</b> divides directly into acceleration (a = F ÷ m) and it also has to be spun up through the gearbox, so it hurts twice.
                    <br /><br /><b style={{ color: T.ink }}>Cd × frontal area</b> is drag, and it grows with the square of speed. It costs almost nothing at the line and dominates at the trap — which is why a van loses far more trap speed than ET compared with a coupe.
                    <br /><br /><b style={{ color: T.ink }}>Centre of gravity height and wheelbase</b> set weight transfer (ΔN = m·a·h ÷ L). A tall van actually transfers more load rearward than a low supercar, which genuinely helps it hook up — one of the few things working in its favour.
                    <br /><br /><b style={{ color: T.ink }}>Static rear weight</b> decides how much grip you start with before any transfer. A mid-engined supercar begins with 57% over the driven axle; a truck has 38%.
                  </ExpandableInfo>
                </BuildSection>

                <BuildSection active={buildSection === 'gearing'} onClick={() => setBuildSection(buildSection === 'gearing' ? null : 'gearing')}
                  icon={Settings} label="Gearbox" sub={`${car.gearCount}-speed ${GEARBOX_OPTS[car.boxIdx].label} · ${car.finalDrive.toFixed(2)} final`}>
                  <div style={{ fontSize: 12, color: T.ink2, marginBottom: 6, fontWeight: 600 }}>Transmission</div>
                  <Seg options={GEARBOX_OPTS.map((o, i) => ({ label: o.label, value: i }))} value={car.boxIdx} onChange={(v) => setCar({ ...car, boxIdx: v })} />
                  <div style={{ fontSize: 11, color: T.ink3, marginTop: 4 }}>{GEARBOX_OPTS[car.boxIdx].note}</div>

                  <div style={{ fontSize: 12, color: T.ink2, margin: '12px 0 6px', fontWeight: 600 }}>Number of gears: {car.gearCount}</div>
                  <input type="range" min={4} max={6} step={1} value={car.gearCount} onChange={(e) => setCar({ ...car, gearCount: Number(e.target.value) })} style={{ width: '100%', accentColor: T.amber }} />

                  <div style={{ fontSize: 12, color: T.ink2, margin: '12px 0 6px', fontWeight: 600 }}>Final drive: {car.finalDrive.toFixed(2)}:1</div>
                  <input type="range" min={2.8} max={4.8} step={0.05} value={car.finalDrive} onChange={(e) => setCar({ ...car, finalDrive: Number(e.target.value) })} style={{ width: '100%', accentColor: T.amber }} />
                  <div style={{ fontSize: 11, color: T.ink3, marginTop: 4 }}>Numerically higher multiplies torque but runs out of road speed sooner.</div>

                  <div style={{ fontSize: 12, color: T.ink2, margin: '12px 0 6px', fontWeight: 600 }}>First gear: {car.gears[0].toFixed(2)}:1</div>
                  <input type="range" min={2.4} max={4.6} step={0.05} value={car.gears[0]}
                    onChange={(e) => { const g = [...car.gears]; g[0] = Number(e.target.value); setCar({ ...car, gears: g }); }}
                    style={{ width: '100%', accentColor: T.amber }} />

                  <ExpandableInfo title="How gearing multiplies torque">
                    Every gear is a torque multiplier and a speed divider at the same time. Torque at the wheel is:
                    <br /><br /><span style={{ fontFamily: T.mono, color: T.cyan, fontSize: 11.5 }}>wheelTorque = engineTorque × gearRatio × finalDrive</span><br />
                    <span style={{ fontFamily: T.mono, color: T.cyan, fontSize: 11.5 }}>force = wheelTorque ÷ tyreRadius</span>
                    <br /><br />So a 3.79 first gear with a 3.54 final multiplies engine torque by 13.4 before it reaches the tyre. That is why first gear spins the wheels and fifth does not — the engine has not changed, the multiplication has.
                    <br /><br />The cost is road speed. The same ratio divides your wheel speed by 13.4, so you run out of revs almost immediately. Choosing gears is choosing where in the RPM range you spend your time, and the answer is: as close to peak torque as you can, as often as possible.
                  </ExpandableInfo>
                </BuildSection>

                <BuildSection active={buildSection === 'tires'} onClick={() => setBuildSection(buildSection === 'tires' ? null : 'tires')}
                  icon={Activity} label="Tyres & Drive" sub={`${TIRE_GRIP[car.gripIdx].label} · ${DRIVETRAIN_OPTS[car.driveIdx].label} · ${car.tireDiameterIn}in`}>
                  <div style={{ fontSize: 12, color: T.ink2, marginBottom: 6, fontWeight: 600 }}>Grip level</div>
                  <Seg options={TIRE_GRIP.map((o, i) => ({ label: o.label, value: i }))} value={car.gripIdx} onChange={(v) => setCar({ ...car, gripIdx: v })} wrap />
                  <div style={{ fontSize: 11, color: T.ink3, marginTop: 4 }}>
                    {TIRE_GRIP[car.gripIdx].note} — coefficient of friction μ = {TIRE_GRIP[car.gripIdx].mu.toFixed(2)}
                  </div>

                  <div style={{ fontSize: 12, color: T.ink2, margin: '12px 0 6px', fontWeight: 600 }}>Driven wheels</div>
                  <Seg options={DRIVETRAIN_OPTS.map((o, i) => ({ label: o.label, value: i }))} value={car.driveIdx} onChange={(v) => setCar({ ...car, driveIdx: v })} />
                  <div style={{ fontSize: 11, color: T.ink3, marginTop: 4 }}>{DRIVETRAIN_OPTS[car.driveIdx].note}</div>

                  <div style={{ fontSize: 12, color: T.ink2, margin: '12px 0 6px', fontWeight: 600 }}>Tyre diameter: {car.tireDiameterIn} in</div>
                  <input type="range" min={22} max={32} step={1} value={car.tireDiameterIn} onChange={(e) => setCar({ ...car, tireDiameterIn: Number(e.target.value) })} style={{ width: '100%', accentColor: T.cyan }} />
                  <div style={{ fontSize: 11, color: T.ink3, marginTop: 4 }}>A taller tyre is a longer lever against the engine — it acts like a numerically lower final drive, and raises the speed reached at any given RPM.</div>

                  <ExpandableInfo title="Why grip is a hard ceiling on acceleration">
                    However much torque you make, the tyre can only transmit what friction allows:
                    <br /><br /><span style={{ fontFamily: T.mono, color: T.cyan, fontSize: 11.5 }}>F_max = μ × N</span>
                    <br /><br />μ is the coefficient of friction and N is the load pressing the driven tyres onto the road. Measured values: street tyres 0.8–0.9, good summer tyres around 1.0, racing slicks 1.7–1.9, and prepared drag surfaces higher still.
                    <br /><br />Divide by mass and you get maximum possible acceleration. At μ = 0.85 the very best you can do is 0.85 g <i>if every kilogram sat on the driven wheels</i> — and on a rear-drive car only about 47% does at rest. That is why extra power past a point simply makes smoke.
                    <br /><br /><b style={{ color: T.ink }}>Weight transfer</b> is what saves it. Accelerating shifts load rearward by <span style={{ fontFamily: T.mono, color: T.cyan }}>ΔN = m × a × h / L</span> — mass times acceleration times centre-of-gravity height, divided by wheelbase. The harder you accelerate, the more load lands on the driven wheels, so grip grows with effort. It is why a rear-drive car can out-launch its static weight distribution, and why AWD wins anyway: it starts with all of it.
                  </ExpandableInfo>
                </BuildSection>
              </>
            )}
          </div>
        )}

        {/* ---------- DYNO: run a pull, then curves / log / datalog / score ---------- */}
        {tab === 'dyno' && (
          <div style={{ padding: 16 }}>
            {mode === 'career' && activeJob != null && (
              <div style={{
                background: jobResult === 'pass' ? T.greenBg : jobResult === 'fail' ? T.redBg : T.panel2,
                border: `1px solid ${jobResult === 'pass' ? '#1f4a30' : jobResult === 'fail' ? '#3a2020' : T.line}`,
                borderRadius: 11, padding: '12px 13px', marginBottom: 14,
              }}>
                <div style={{ fontSize: 10, letterSpacing: 1, fontWeight: 800, color: jobResult === 'pass' ? T.green : jobResult === 'fail' ? T.red : T.ink2 }}>
                  {jobResult === 'pass' ? 'JOB COMPLETE' : jobResult === 'fail' ? 'NOT THERE YET' : 'JOB IN PROGRESS'}
                </div>
                <div style={{ fontSize: 13, fontWeight: 700, color: T.ink, marginTop: 3 }}>{CAREER_JOBS[activeJob].title}</div>
                <div style={{ fontSize: 11.5, color: T.ink2, marginTop: 5 }}>Target: {CAREER_JOBS[activeJob].target}</div>
                {jobResult === 'pass' && (
                  <div style={{ fontSize: 12, color: '#a5aebb', lineHeight: 1.5, marginTop: 8, paddingTop: 8, borderTop: `1px solid ${T.line}` }}>
                    <b style={{ color: T.green }}>What this job taught: </b>{CAREER_JOBS[activeJob].teaches}
                  </div>
                )}
                {jobResult === 'fail' && (
                  <div style={{ fontSize: 11.5, color: '#ff9d9d', marginTop: 7 }}>Read the Pull Log below — it names the cause and what to change.</div>
                )}
              </div>
            )}

            {journeyStep === 3 && <JourneyBanner step={3} onAdvance={() => setJourneyStep(99)} onDismiss={() => setJourneyStep(99)} />}
            <Eyebrow icon={Activity}>Dyno Cell</Eyebrow>
            <div style={{ fontSize: 12, color: T.ink2, marginBottom: 8, fontWeight: 600 }}>Manifold pressure for the pull (load)</div>
            <Seg options={[100, 70, 40].map((l) => ({ label: `${l} kPa`, value: l }))} value={loadKpa} onChange={setLoadKpa} />
            <div style={{ fontSize: 10.5, color: T.ink3, marginTop: 6, marginBottom: 4, lineHeight: 1.5 }}>
              This selects <b style={{ color: T.ink2 }}>throttle opening</b>, not the final pressure. ~100 kPa is wide-open throttle naturally aspirated.
              {turboOn && peakBoostPsi > 0 && (
                <span style={{ color: T.amberInk }}> With {peakBoostPsi} psi of boost this pull will actually peak near <b>{Math.round(BARO_KPA + peakBoostPsi * PSI_TO_KPA)} kPa</b> in the manifold, walking the tables into the boost rows.</span>
              )}
            </div>

            <div style={{ margin: '14px 0' }}><Tach rpm={running || result ? currentRpm : 1500} cylinders={engineDerived.cyl} running={running} /></div>

            <button onClick={doRun} disabled={running} style={{
              width: '100%', padding: '15px 0', borderRadius: 12, border: 'none', marginBottom: 16,
              background: running ? '#3a2c1c' : T.amber, color: '#1a0f08', fontWeight: 800, fontSize: 14.5,
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, letterSpacing: 0.3,
              boxShadow: running ? 'none' : '0 6px 18px rgba(255,106,44,0.22)',
            }}>
              <Play size={16} />
              {!running ? 'RUN DYNO PULL'
                : dynoPhase === 'settle' ? 'IDLING…'
                : dynoPhase === 'sweep' ? 'SWEEPING…'
                : dynoPhase === 'spooldown' ? 'COMING BACK DOWN…'
                : 'SETTLING…'}
            </button>

            {result && (
              <>
                <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
                  <StatTile label="PEAK WHP" value={result.peakHp} color={T.amberInk} />
                  <StatTile label="PEAK TQ" value={result.peakTq} unit="lb-ft" color={T.cyan} />
                </div>

                {prevResult && !running && (() => {
                  const dHp = result.peakHp - prevResult.peakHp;
                  const dTq = result.peakTq - prevResult.peakTq;
                  const knockNow = result.events.filter((e) => e.type === 'knock').length;
                  const knockPrev = prevResult.events.filter((e) => e.type === 'knock').length;
                  const dKnock = knockNow - knockPrev;
                  const fmtDelta = (v, unit) => `${v > 0 ? '+' : ''}${v}${unit}`;
                  return (
                    <Panel tight style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
                      <TrendingUp size={15} color={T.ink2} style={{ flexShrink: 0 }} />
                      <div style={{ display: 'flex', gap: 14, fontSize: 12.5, flexWrap: 'wrap' }}>
                        <span style={{ color: dHp === 0 ? T.ink2 : dHp > 0 ? T.green : '#ff8f8f', fontFamily: T.mono, fontWeight: 800 }}>{fmtDelta(dHp, ' whp')}</span>
                        <span style={{ color: dTq === 0 ? T.ink2 : dTq > 0 ? T.green : '#ff8f8f', fontFamily: T.mono, fontWeight: 800 }}>{fmtDelta(dTq, ' lb-ft')}</span>
                        <span style={{ color: dKnock === 0 ? T.ink2 : dKnock < 0 ? T.green : '#ff9d9d', fontFamily: T.mono, fontWeight: 800 }}>{knockNow} knock{knockNow === 1 ? '' : 's'} {dKnock !== 0 ? `(${fmtDelta(dKnock, '')})` : ''}</span>
                      </div>
                    </Panel>
                  );
                })()}

                {!running && (
                  <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
                    {[['result', 'CURVES'], ['log', 'PULL LOG'], ['data', 'DATALOG'], ['score', 'SCORE']].map(([id, label]) => {
                      const on = dynoView === id;
                      const flag = id === 'log' && result.events.length > 0;
                      return (
                        <button key={id} onClick={() => setDynoView(id)} style={{
                          flex: 1, padding: '9px 0', borderRadius: 9, fontWeight: 800, fontSize: 10, letterSpacing: 0.3,
                          border: `1px solid ${on ? T.amber : T.line}`, background: on ? T.amberBg : T.panel2,
                          color: on ? T.amberInk : T.ink2, position: 'relative',
                        }}>
                          {label}
                          {flag && <span style={{ position: 'absolute', top: 5, right: 7, width: 5, height: 5, borderRadius: 3, background: T.red }} />}
                        </button>
                      );
                    })}
                  </div>
                )}

                {(running || dynoView === 'result') && (
                <>
                <Panel tight style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 10, color: T.ink2, letterSpacing: 1, fontWeight: 700, padding: '2px 0 8px' }}>POWER &amp; TORQUE</div>
                  <ResponsiveContainer width="100%" height={200}>
                    <LineChart data={chartData} margin={{ top: 4, right: 12, left: -14, bottom: 0 }}>
                      <CartesianGrid stroke={T.line} />
                      <XAxis dataKey="rpm" stroke={T.ink3} fontSize={10} type="number" domain={[1500, 7500]} />
                      <YAxis stroke={T.ink3} fontSize={10} />
                      <Tooltip contentStyle={{ background: T.panel2, border: `1px solid ${T.line}`, fontSize: 11 }} />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      {prevResult && <Line dataKey="prevHp" name="Prev WHP" stroke="#3a4149" strokeDasharray="4 3" dot={false} isAnimationActive={false} />}
                      {prevResult && <Line dataKey="prevTorque" name="Prev TQ" stroke="#3a4149" strokeDasharray="4 3" dot={false} isAnimationActive={false} />}
                      <Line dataKey="hp" name="WHP" stroke={T.amber} strokeWidth={2} dot={false} isAnimationActive={false} />
                      <Line dataKey="torque" name="Torque" stroke={T.cyan} strokeWidth={2} dot={false} isAnimationActive={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </Panel>

                <Panel tight style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 10, color: T.ink2, letterSpacing: 1, fontWeight: 700, padding: '2px 0 8px' }}>AFR (COMMANDED VS ACTUAL) / TIMING</div>
                  <ResponsiveContainer width="100%" height={180}>
                    <LineChart data={chartData} margin={{ top: 4, right: 12, left: -14, bottom: 0 }}>
                      <CartesianGrid stroke={T.line} />
                      <XAxis dataKey="rpm" stroke={T.ink3} fontSize={10} type="number" domain={[1500, 7500]} />
                      <YAxis stroke={T.ink3} fontSize={10} />
                      <Tooltip contentStyle={{ background: T.panel2, border: `1px solid ${T.line}`, fontSize: 11 }} />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      <Line dataKey="afrCommanded" name="AFR commanded" stroke="#5c6672" strokeDasharray="3 3" dot={false} isAnimationActive={false} />
                      <Line dataKey="afr" name="AFR actual" stroke={T.green} strokeWidth={2} dot={false} isAnimationActive={false} />
                      <Line dataKey="timing" name="Timing used" stroke={T.yellow} strokeWidth={2} dot={false} isAnimationActive={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </Panel>
                </>
                )}

                {!running && dynoView === 'data' && (
                  <>
                    <Eyebrow icon={Info}>Datalog</Eyebrow>
                    <div style={{ fontSize: 12, color: T.ink2, lineHeight: 1.55, marginBottom: 10 }}>
                      One card per RPM breakpoint. Each line pairs <b style={{ color: T.ink }}>what you asked for</b> with <b style={{ color: T.ink }}>what the engine actually did</b> — a mismatch is the ECU telling you something.
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
                      {RPM.map((r) => {
                        const p = result.points.find((pt) => pt.rpm === r);
                        if (!p) return null;
                        const bad = p.knock || p.fuelLimited || p.leanRisk || p.richRisk;
                        const warn = !bad && (p.duty > 85 || p.egt > 870);
                        const edge = bad ? T.red : warn ? T.yellow : T.line;

                        // Each row: label, what was asked, what happened, and a verdict.
                        const rows = [
                          { k: 'Airflow', asked: null, got: `${p.maf} g/s`, note: `${p.map} kPa manifold · ${p.ve}% VE`, ok: true },
                          { k: 'Timing', asked: `${p.commandedTiming}°`, got: `${p.timing}°`,
                            note: p.knock ? `ECU pulled ${p.knockPull.toFixed(1)}° — too advanced for this cylinder pressure` : 'ran your commanded value',
                            ok: !p.knock },
                          { k: 'Mixture', asked: `${p.afrCommanded}:1`, got: `${p.afr}:1`,
                            note: p.fuelLimited ? 'injectors out of time — mixture leaned out on its own'
                              : p.richRisk ? 'far richer than commanded — check injector scaling'
                              : `lambda ${p.lambda} · best power here is ${p.bestAfr}:1`,
                            ok: !p.fuelLimited && !p.richRisk && !p.leanRisk },
                          { k: 'Injectors', asked: null, got: `${p.duty}% duty`,
                            note: `${p.pw} ms of the ${(120000 / p.rpm).toFixed(1)} ms available${p.duty > 90 ? ' — at the limit' : ''}`,
                            ok: p.duty <= 90 },
                          { k: 'Heat', asked: null, got: `${p.egt}°C`,
                            note: `intake charge ${p.iat}°C${p.egt > 950 ? ' · exhaust running hot' : ''}`,
                            ok: p.egt <= 950 },
                        ];

                        return (
                          <div key={r} style={{ border: `1px solid ${edge}`, borderRadius: 10, background: T.panel2, overflow: 'hidden' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '9px 12px', background: bad ? T.redBg : warn ? T.yellowBg : T.panel }}>
                              <span style={{ fontFamily: T.mono, fontWeight: 800, fontSize: 14, color: T.ink }}>{r} RPM</span>
                              <span style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: bad ? T.red : warn ? T.yellow : T.green }}>
                                {p.hp} whp · {p.torque} lb-ft{bad ? '  ⚠' : warn ? '  !' : '  ✓'}
                              </span>
                            </div>
                            <div style={{ padding: '4px 12px 10px' }}>
                              {rows.map((row, i) => (
                                <div key={i} style={{ paddingTop: 7 }}>
                                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                                    <span style={{ fontSize: 11.5, color: T.ink2, fontWeight: 600, minWidth: 62 }}>{row.k}</span>
                                    <span style={{ fontFamily: T.mono, fontSize: 12, color: row.ok ? T.ink : T.red, fontWeight: 700, textAlign: 'right' }}>
                                      {row.asked != null && <span style={{ color: T.ink3, fontWeight: 400 }}>{row.asked} → </span>}
                                      {row.got}
                                    </span>
                                  </div>
                                  <div style={{ fontSize: 10.5, color: row.ok ? T.ink3 : '#ff9d9d', lineHeight: 1.4, marginTop: 1 }}>{row.note}</div>
                                </div>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    <ExpandableInfo title="How to read a datalog">
                      Diagnosis happens in the <b style={{ color: T.ink }}>asked → got</b> pairs, not in the power number.
                      <br /><br /><b style={{ color: T.ink }}>Timing</b>: if the two differ, the ECU overrode you. That is knock retard, and the gap is how far past the limit your table was. Tuners treat anything sustained above ~2° as damaging.
                      <br /><br /><b style={{ color: T.ink }}>Mixture</b>: if actual is not what you commanded, the cause is upstream of the fuel table — usually injectors out of duty cycle, MAF scaling, or an ECU injector size that does not match the hardware. Do not paper over it by editing fuel cells; fix the cause.
                      <br /><br /><b style={{ color: T.ink }}>Injectors</b>: duty is a time budget. At 7500 RPM there are only 16 ms in an engine cycle. Past about 90% there is no room left and the mixture goes lean regardless of what you asked for.
                      <br /><br /><b style={{ color: T.ink }}>Heat</b>: exhaust temperature rises with retarded timing and lean mixtures. Sustained above ~950°C cooks turbines and valves.
                    </ExpandableInfo>

                    <Eyebrow icon={Grid3x3}>Fuel Trim Histogram</Eyebrow>
                    <ExpandableInfo title="How real tuners actually correct a VE table">
                      This is the workflow every professional platform is built around. You log a pull, bin the difference between commanded and actual mixture onto the same RPM x MAP grid as your VE table, then apply that error back into the cells.
                      <br /><br />A cell reading <b style={{ color: T.ink }}>+6%</b> means the engine ran 6% leaner than you commanded. The only way that happens is if there was more air in the cylinder than your VE table claimed — so the VE number there is 6% too low and should come up 6%. A negative cell means it ran rich, so the table is over-estimating air and VE comes down.
                      <br /><br />Correct, re-pull, repeat until the histogram reads flat. This is why a VE table converges on reality instead of on guesswork.
                    </ExpandableInfo>
                    {!histogram ? (
                      <button onClick={buildHistogram} style={{ width: '100%', padding: '12px 0', borderRadius: 10, border: `1px solid ${T.cyan}`, background: T.cyanBg, color: T.cyan, fontWeight: 800, fontSize: 12.5, marginBottom: 16 }}>
                        BUILD HISTOGRAM FROM THIS PULL
                      </button>
                    ) : (
                      <div style={{ marginBottom: 16 }}>
                        <div style={{ overflowX: 'auto', border: `1px solid ${T.line}`, borderRadius: 10, marginBottom: 8 }}>
                          <div style={{ display: 'inline-block', minWidth: '100%' }}>
                            <div style={{ display: 'flex' }}>
                              <div style={{ width: 44, flexShrink: 0, background: T.panel }} />
                              {RPM.map((r) => (
                                <div key={r} style={{ width: 51, height: 26, flexShrink: 0, background: T.panel, color: T.ink2, fontFamily: T.mono, fontSize: 9.5, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', borderLeft: `1px solid ${T.line}` }}>{r}</div>
                              ))}
                            </div>
                            {LOAD.map((m, ri) => (
                              <div key={m} style={{ display: 'flex' }}>
                                <div style={{ width: 44, height: 32, flexShrink: 0, background: T.panel, color: T.ink2, fontFamily: T.mono, fontSize: 9.5, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', borderTop: `1px solid ${T.line}` }}>{m}</div>
                                {RPM.map((_, ci) => {
                                  const e = histogram[ri][ci];
                                  const mag = e == null ? 0 : Math.min(1, Math.abs(e) / 12);
                                  const bg = e == null ? T.panel2 : `hsl(${e > 0 ? 8 : 200}, 60%, ${14 + mag * 22}%)`;
                                  return (
                                    <div key={ci} style={{ width: 51, height: 32, flexShrink: 0, background: bg, color: e == null ? T.ink3 : '#fff', fontFamily: T.mono, fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid rgba(0,0,0,0.35)' }}>
                                      {e == null ? '—' : `${e > 0 ? '+' : ''}${e.toFixed(1)}`}
                                    </div>
                                  );
                                })}
                              </div>
                            ))}
                          </div>
                        </div>
                        <div style={{ fontSize: 10.5, color: T.ink3, marginBottom: 8 }}>Cells show % airflow error (blank = not visited during this pull). Rows are MAP kPa, columns RPM.</div>
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button onClick={applyHistogram} style={{ flex: 2, padding: '12px 0', borderRadius: 10, border: 'none', background: T.amber, color: '#1a0f08', fontWeight: 800, fontSize: 12.5 }}>
                            APPLY CORRECTIONS TO VE
                          </button>
                          <button onClick={() => setHistogram(null)} style={{ flex: 1, padding: '12px 0', borderRadius: 10, border: `1px solid ${T.line}`, background: T.panel2, color: T.ink2, fontWeight: 700, fontSize: 12.5 }}>
                            DISCARD
                          </button>
                        </div>
                      </div>
                    )}

                  </>
                )}

                {!running && dynoView === 'log' && (
                  <>
                    <Eyebrow icon={AlertTriangle}>Pull Log</Eyebrow>
                    {result.events.length === 0 ? (
                      <div style={{ fontSize: 12.5, color: T.green, background: T.greenBg, border: '1px solid #1f4a30', borderRadius: 10, padding: 12 }}>
                        Clean pull — no knock, fueling, or trim issues across the sweep.
                      </div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {result.events.map((e, i) => {
                          const isDanger = e.type === 'knock' || e.type === 'valve' || e.type === 'rich' || e.type === 'injscale' || e.type === 'float';
                          const isWarn = e.type === 'lean' || e.type === 'fuel' || e.type === 'compressor' || e.type === 'cam';
                          const isViolet = e.type === 'maf';
                          const bg = isDanger ? T.redBg : isWarn ? T.yellowBg : isViolet ? T.violetBg : T.panel2;
                          const bd = isDanger ? '#3a2020' : isWarn ? '#3a2f16' : isViolet ? '#382a4a' : T.line;
                          const fg = isDanger ? '#ff9d9d' : isWarn ? '#ffcf8a' : isViolet ? T.violet : T.cyan;
                          return (
                            <div key={i} style={{ padding: '11px 12px', borderRadius: 10, background: bg, border: `1px solid ${bd}` }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                                <div style={{ display: 'flex', gap: 8, fontSize: 12.5, fontWeight: 700, color: fg }}>
                                  <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
                                  <span>{e.msg}</span>
                                </div>
                                {e.impact != null && <span style={{ fontSize: 11, fontFamily: T.mono, fontWeight: 800, color: fg, flexShrink: 0 }}>-{e.impact}</span>}
                              </div>
                              {e.cause && <div style={{ fontSize: 11.5, color: '#9aa4b0', marginTop: 6, paddingLeft: 22 }}><b style={{ color: '#c3cad2' }}>Why: </b>{e.cause}</div>}
                              {e.fix && <div style={{ fontSize: 11.5, color: '#9aa4b0', marginTop: 4, paddingLeft: 22 }}><b style={{ color: '#c3cad2' }}>Try: </b>{e.fix}</div>}
                            </div>
                          );
                        })}
                      </div>
                    )}

                  </>
                )}

                {!running && dynoView === 'score' && scores && (
                      <>
                        <Eyebrow icon={Trophy}>Scorecard</Eyebrow>
                        <Panel style={{ marginBottom: 10, background: T.amberBg, border: `1px solid ${T.amber}`, textAlign: 'center' }}>
                          <div style={{ fontSize: 10, color: T.amberInk, letterSpacing: 1.5, fontWeight: 800 }}>PULL SCORE</div>
                          <div style={{ fontSize: 40, fontWeight: 800, fontFamily: T.mono, color: T.amberInk, lineHeight: 1.1 }}>{scores.pull}</div>
                          <div style={{ fontSize: 11.5, color: scores.pull >= bestScore ? T.green : T.ink2, fontWeight: 700, marginTop: 2 }}>
                            {scores.pull >= bestScore ? 'NEW BEST' : `Best: ${bestScore}`}
                          </div>
                        </Panel>
                        <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
                          {[['TUNING SCORE', scores.tuning], ['ENGINEER SCORE', scores.engineer]].map(([label, s]) => {
                            const c = statusColor(s.score);
                            return (
                              <div key={label} style={{ flex: 1, background: T.panel2, border: `1px solid ${T.line}`, borderRadius: 12, padding: 14 }}>
                                <div style={{ fontSize: 9.5, color: T.ink2, letterSpacing: 1, fontWeight: 700 }}>{label}</div>
                                <div style={{ fontSize: 28, fontWeight: 800, fontFamily: T.mono, color: c, marginTop: 2 }}>{s.score}</div>
                                <div style={{ fontSize: 11, color: c, fontWeight: 700 }}>{s.label}</div>
                              </div>
                            );
                          })}
                        </div>
                        <Note>Pull Score rewards actual output (peak whp + torque), scaled by how clean (Tuning) and how sound (Engineer) the build is — a big, slightly imperfect pull can still out-score a small, spotless one. It has no ceiling; every pull is a chance to beat your best.</Note>
                        {(scores.tuning.deductions.length > 0 || scores.engineer.deductions.length > 0) && (
                          <Panel tight style={{ marginBottom: 16, fontSize: 11.5, color: '#9aa4b0', fontFamily: T.mono, lineHeight: 1.8 }}>
                            {scores.tuning.deductions.map((d, i) => <div key={'t' + i}>{d}</div>)}
                            {scores.engineer.deductions.map((d, i) => <div key={'e' + i}>{d}</div>)}
                          </Panel>
                        )}
                  </>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* Bottom nav */}
      <div style={{ display: 'flex', borderTop: `1px solid ${T.line}`, background: T.panel, paddingBottom: 'env(safe-area-inset-bottom)' }}>
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button key={t.id} onClick={() => changeTab(t.id)} style={{
              flex: 1, padding: '10px 0 9px', background: 'none', border: 'none', position: 'relative',
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
              color: active ? T.amberInk : T.ink3,
            }}>
              {active && <div style={{ position: 'absolute', top: 0, left: '30%', right: '30%', height: 2, background: T.amber, borderRadius: '0 0 2px 2px' }} />}
              <Icon size={17} />
              <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: 0.3 }}>{t.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
