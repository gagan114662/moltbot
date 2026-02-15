import type { Editor } from "tldraw";
import { createContext, useCallback, useContext, useState } from "react";

interface EditorContextValue {
  editor: Editor | null;
  setEditor: (editor: Editor) => void;
}

const EditorContext = createContext<EditorContextValue>({
  editor: null,
  setEditor: () => {},
});

export function EditorProvider({ children }: { children: React.ReactNode }) {
  const [editor, setEditorState] = useState<Editor | null>(null);
  const setEditor = useCallback((e: Editor) => setEditorState(e), []);

  return <EditorContext.Provider value={{ editor, setEditor }}>{children}</EditorContext.Provider>;
}

export function useEditorContext() {
  return useContext(EditorContext);
}
