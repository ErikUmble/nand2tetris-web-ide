import { FileSystem } from "@davidsouther/jiffies/lib/esm/fs";
import {
  Err,
  Ok,
  isErr,
  unwrap,
} from "@davidsouther/jiffies/lib/esm/result.js";
import {
  Format,
  KeyboardAdapter,
  MemoryAdapter,
  MemoryKeyboard,
  ROM,
} from "@nand2tetris/simulator/cpu/memory.js";
import { Span } from "@nand2tetris/simulator/languages/base.js";
import { TST } from "@nand2tetris/simulator/languages/tst.js";
import { loadAsm, loadBlob, loadHack } from "@nand2tetris/simulator/loader.js";
import { CPUTest } from "@nand2tetris/simulator/test/cputst.js";
import { Action } from "@nand2tetris/simulator/types.js";
import { Dispatch, MutableRefObject, useContext, useMemo, useRef } from "react";
import { ScreenScales } from "src/chips/screen.js";
import { RunSpeed } from "src/runbar.js";
import { compare } from "../compare.js";
import { loadTestFiles } from "../file_utils.js";
import { useImmerReducer } from "../react.js";
import { BaseContext } from "./base.context.js";
import { ImmMemory } from "./imm_memory.js";

function makeTst() {
  return `repeat {
  ticktock;
}`;
}

export interface CpuSim {
  A: number;
  D: number;
  PC: number;
  RAM: MemoryAdapter;
  ROM: MemoryAdapter;
  Screen: MemoryAdapter;
  Keyboard: KeyboardAdapter;
}

export interface CPUTestSim {
  name: string;
  tst: string;
  cmp: string;
  out: string;
  highlight: Span | undefined;
  valid: boolean;
}

export interface CPUPageConfig {
  romFormat: Format;
  ramFormat: Format;
  screenScale: ScreenScales;
  speed: RunSpeed;
  testSpeed: RunSpeed;
}

export interface CpuPageState {
  sim: CpuSim;
  test: CPUTestSim;
  path: string;
  tests: string[];
  title?: string;
  config: CPUPageConfig;
}

function reduceCPUTest(
  cpuTest: CPUTest,
  dispatch: MutableRefObject<CpuStoreDispatch>,
): CpuSim {
  const RAM = new ImmMemory(cpuTest.cpu.RAM, dispatch);
  const ROM = new ImmMemory(cpuTest.cpu.ROM, dispatch);
  const Screen = new ImmMemory(cpuTest.cpu.Screen, dispatch);
  const Keyboard = new MemoryKeyboard(new ImmMemory(cpuTest.cpu.RAM, dispatch));

  return {
    A: cpuTest.cpu.A,
    D: cpuTest.cpu.D,
    PC: cpuTest.cpu.PC,
    RAM,
    ROM,
    Screen,
    Keyboard,
  };
}

export type CpuStoreDispatch = Dispatch<{
  action: keyof ReturnType<typeof makeCpuStore>["reducers"];
  payload?: unknown;
}>;

export function makeCpuStore(
  fs: FileSystem,
  setStatus: Action<string>,
  storage: Record<string, string>,
  dispatch: MutableRefObject<CpuStoreDispatch>,
) {
  let test = new CPUTest();
  let animate = true;
  let valid = true;
  let path = "";
  let tests: string[] = [];
  let tstName = "";
  let _title: string | undefined;

  const reducers = {
    update(state: CpuPageState) {
      state.sim = reduceCPUTest(test, dispatch);
      state.test.highlight = test.currentStep?.span;
      state.test.valid = valid;
      state.path = path;
      state.tests = Array.from(tests);
      state.test.name = tstName;
    },

    setTest(state: CpuPageState, { tst, cmp }: { tst?: string; cmp?: string }) {
      state.test.tst = tst ?? state.test.tst;
      state.test.cmp = cmp ?? state.test.cmp;
      state.test.out = "";
    },

    testStep(state: CpuPageState) {
      state.test.out = test.log();
      this.update(state);
    },

    testFinished(state: CpuPageState) {
      if (state.test.cmp.trim() === "") {
        return;
      }
      const passed = compare(state.test.cmp.trim(), test.log().trim());
      setStatus(
        passed
          ? `Simulation successful: The output file is identical to the compare file`
          : `Simulation error: The output file differs from the compare file`,
      );
    },

    setTitle(state: CpuPageState, title?: string) {
      _title = title;
      state.title = title;
      if (title) {
        test.fileLoaded = true;
      }
    },

    updateConfig(state: CpuPageState, config: Partial<CPUPageConfig>) {
      state.config = { ...state.config, ...config };
    },
  };

  const actions = {
    tick() {
      test.cpu.tick();
    },

    setAnimate(value: boolean) {
      animate = value;
    },

    async setPath(_path: string) {
      path = _path;

      const dir = path.split("/").slice(0, -1).join("/");
      const files = await fs.scandir(dir);
      tests = files
        .filter((file) => file.name.endsWith(".tst"))
        .map((file) => file.name);

      if (tests.length > 0) {
        this.loadTest(tests[0]);
      } else {
        tstName = "Default";
        this.compileTest(makeTst(), "");
      }

      dispatch.current({ action: "update" });
    },

    async testStep() {
      try {
        const done = await test.step();
        if (animate || done) {
          dispatch.current({ action: "testStep" });
        }
        if (done) {
          dispatch.current({ action: "testFinished" });
        }
        return done;
      } catch (e) {
        setStatus((e as Error).message);
        return true;
      }
    },

    resetRAM() {
      test.cpu.RAM.loadBytes([]);
      dispatch.current({ action: "update" });
      setStatus("Reset RAM");
    },

    toggleUseTest() {
      dispatch.current({ action: "update" });
    },

    reset() {
      test.reset();
      dispatch.current({ action: "update" });
    },

    clear() {
      this.replaceROM(new ROM());
      this.resetRAM();
      this.clearTest();
      this.reset();
      dispatch.current({ action: "setTitle", payload: undefined });
    },

    clearTest() {
      tstName = "";
      this.compileTest(makeTst(), "");
      dispatch.current({ action: "update" });
    },

    replaceROM(rom: ROM) {
      test = new CPUTest({ dir: path, rom });
      this.clearTest();
    },

    compileTest(file: string, cmp?: string, _path?: string) {
      const tstPath = _path ?? path;
      dispatch.current({ action: "setTest", payload: { tst: file, cmp } });
      const tst = TST.parse(file);

      if (isErr(tst)) {
        setStatus(`Failed to parse test - ${Err(tst).message}`);
        valid = false;
        dispatch.current({ action: "update" });
        return false;
      }
      valid = true;

      const maybeTest = CPUTest.from(Ok(tst), {
        dir: tstPath,
        rom: test.cpu.ROM,
        doEcho: setStatus,
        doLoad: async (path) => {
          let file;
          try {
            file = await fs.readFile(path);
          } catch (e) {
            throw new Error(`Cannot find ${path}`);
          }
          const loader = path.endsWith("hack")
            ? loadHack
            : path.endsWith("asm")
              ? loadAsm
              : loadBlob;
          const bytes = await loader(file);
          console.log(bytes);
          test.cpu.ROM.loadBytes(bytes);
        },
        compareTo: async (file) => {
          const dir = tstPath.split("/").slice(0, -1).join("/");
          const cmp = await fs.readFile(`${dir}/${file}`);
          dispatch.current({ action: "setTest", payload: { cmp } });
        },
        requireLoad: false,
      });

      if (isErr(maybeTest)) {
        setStatus(Err(maybeTest).message);
        return false;
      } else {
        test = Ok(maybeTest);
        test.fileLoaded = _title != undefined;
        dispatch.current({ action: "update" });
        return true;
      }
    },

    async loadTest(name: string) {
      const dir = path.split("/").slice(0, -1).join("/");
      const files = await loadTestFiles(fs, `${dir}/${name}`);
      if (isErr(files)) {
        setStatus(`Failed to load test`);
        return;
      }
      tstName = name;
      const { tst } = unwrap(files);
      this.compileTest(tst, "");
    },
  };

  const initialState: CpuPageState = {
    sim: reduceCPUTest(test, dispatch),
    test: {
      highlight: test.currentStep?.span,
      name: "",
      tst: makeTst(),
      cmp: "",
      out: "",
      valid: true,
    },
    path: "",
    tests: [],
    config: {
      romFormat: "asm",
      ramFormat: "dec",
      screenScale: 1,
      speed: 2,
      testSpeed: 2,
    },
  };

  return { initialState, reducers, actions };
}

export function useCpuPageStore() {
  const { fs, setStatus, storage } = useContext(BaseContext);

  const dispatch = useRef<CpuStoreDispatch>(() => undefined);

  const { initialState, reducers, actions } = useMemo(
    () => makeCpuStore(fs, setStatus, storage, dispatch),
    [fs, setStatus, storage, dispatch],
  );

  const [state, dispatcher] = useImmerReducer(reducers, initialState);
  dispatch.current = dispatcher;

  return { state, dispatch, actions };
}
