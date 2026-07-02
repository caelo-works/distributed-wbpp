/*
 * ProcessSerializer.js — capture a configured PixInsight process on the server
 * and reproduce it identically on a worker.
 *
 * This is viable because WBPP itself serializes processes this way: in
 * BPP-operations.js (WBPP 2.9.1, line ~1893) StarAlignment is dumped with
 *   SA.toSource("JavaScript", "SA", 0,
 *               SourceCodeFlag_NoTimeInfo | SourceCodeFlag_NoReadOnlyParams |
 *               SourceCodeFlag_NoDescription)
 *
 * The produced source is plain PJSR that, when eval'd on the worker, rebuilds an
 * identical instance. Determinism across nodes is guaranteed by the strict
 * version handshake (same PixInsight + WBPP everywhere).
 */

#ifndef __WBPP_ProcessSerializer_js
#define __WBPP_ProcessSerializer_js

function serializeProcess( processInstance, varId )
{
   // Exclude time info / read-only params / descriptions so the source is a pure,
   // reproducible parameter assignment (exactly what WBPP uses internally).
   return processInstance.toSource(
      "JavaScript", varId || "P", 0,
      SourceCodeFlag_NoTimeInfo | SourceCodeFlag_NoReadOnlyParams | SourceCodeFlag_NoDescription
   ).trim();
}

/*
 * Rebuild a process instance from source produced by serializeProcess. The
 * source declares `var <varId> = new <ProcessClass>; <varId>.param = ...;`, so we
 * eval it and return the named variable. Worker-side only.
 */
function deserializeProcess( source, varId )
{
   varId = varId || "P";
   // eslint-disable-next-line no-eval
   eval( source );
   return eval( varId );
}

#endif // __WBPP_ProcessSerializer_js
