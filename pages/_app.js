import "../styles/globals.css";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { loadState, saveState, defaultState } from "../lib/store";

const Ctx = createContext(null);
export const useStore = () => useContext(Ctx);

export default function App({ Component, pageProps }) {
  const [state, setState] = useState(defaultState);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setState(loadState());
    setReady(true);
  }, []);

  useEffect(() => {
    if (ready) saveState(state);
  }, [state, ready]);

  const api = useMemo(
    () => ({
      state,
      ready,
      setState,
      patch: (fn) => setState((s) => fn({ ...s })),
    }),
    [state, ready]
  );

  return (
    <Ctx.Provider value={api}>
      <Component {...pageProps} />
    </Ctx.Provider>
  );
}
