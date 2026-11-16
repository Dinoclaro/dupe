import { CompileRequest, compileLatexPreview } from './latexCompiler';

self.onmessage = (event: MessageEvent<CompileRequest>) => {
  const response = compileLatexPreview(event.data);
  self.postMessage(response);
};
