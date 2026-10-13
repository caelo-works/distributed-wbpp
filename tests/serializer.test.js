// Node unit test for pjsr/lib/ProcessSerializer.js and the job checks of
// pjsr/lib/WorkerRuntime.js, with a stub process standing in for PixInsight's.
// Run: node tests/serializer.test.js
"use strict";
const fs = require( "fs" );
const path = require( "path" );
const assert = require( "assert" );

const lib = path.join( __dirname, "..", "pjsr", "lib" );
const strip = f => fs.readFileSync( path.join( lib, f ), "utf8" ).replace( /^#.*$/mg, "" );

global.SourceCodeFlag = { NoTimeInfo: 1, NoReadOnlyParams: 2, NoDescription: 4 };
function makeProcess( id )
{
   return class
   {
      constructor() { this.mode = 1; this.label = ""; this.flag = false; this.targets = []; }
      processId() { return id; }
      toSource()
      {
         return "var P = new " + id + ";\nP.mode = 1;\nP.label = \"\";\nP.flag = false;\n" +
                "P.targets = [ // enabled, isFile, image\n];\n";
      }
   };
}
for ( const id of [ "StarAlignment", "ImageCalibration", "LocalNormalization", "ImageIntegration", "DrizzleIntegration" ] )
   global[ id ] = makeProcess( id );

// Load the library into this scope: PJSR files are plain scripts, not modules.
// (Test-only loader; the scripts themselves never evaluate code.)
const load = src => ( 0, eval )( src );
load( strip( "ProcessSerializer.js" ).replace( "var WBPP_PROCESS_ALLOWLIST", "globalThis.WBPP_PROCESS_ALLOWLIST" ) );
const wr = strip( "WorkerRuntime.js" );
function fnSource( name )
{
   const i = wr.indexOf( "function " + name + "(" );
   for ( let k = wr.indexOf( "{", i ), depth = 0; k < wr.length; ++k )
   {
      if ( wr[ k ] == "{" ) ++depth;
      if ( wr[ k ] == "}" && --depth == 0 ) return wr.slice( i, k + 1 );
   }
   throw new Error( "no function " + name );
}
load( "globalThis.WBPP_OP_PROCESS = " + wr.match( /var WBPP_OP_PROCESS = (\{[\s\S]*?\});/ )[ 1 ] );
for ( const name of [ "checkJobFileName", "checkJobFiles", "rebuildJobProcess" ] )
   load( "globalThis." + name + " = " + fnSource( name ) );

let passed = 0;
function rejects( fn, re, what )
{
   assert.throws( fn, re, what );
   ++passed;
}

// round trip
const P = new StarAlignment;
P.mode = 3; P.label = "x/y"; P.targets = [ [ true, true, "C:/a.xisf" ] ];
const data = JSON.parse( JSON.stringify( serializeProcess( P ) ) );
assert.deepStrictEqual( data, { id: "StarAlignment", params: { mode: 3, label: "x/y", flag: false, targets: [ [ true, true, "C:/a.xisf" ] ] } } );
const back = deserializeProcess( data, "StarAlignment" );
assert.strictEqual( back.process.mode, 3 );
assert.deepStrictEqual( back.process.targets, [ [ true, true, "C:/a.xisf" ] ] );
assert.ok( processHasParameter( back, "targets" ) );
assert.ok( !processHasParameter( back, "constructor" ) );
passed += 5;

// rejections
rejects( () => deserializeProcess( { id: "ExternalProcess", params: {} } ), /not allowed/, "process outside the allowlist" );
rejects( () => deserializeProcess( { id: "ImageIntegration", params: {} }, "StarAlignment" ), /expected StarAlignment/, "process id not matching the op" );
rejects( () => deserializeProcess( { id: "StarAlignment", params: { evil: 1 } } ), /unknown parameter/, "unknown parameter" );
rejects( () => deserializeProcess( { id: "StarAlignment", params: { mode: "1" } } ), /must be a number/, "scalar type" );
rejects( () => deserializeProcess( { id: "StarAlignment", params: { targets: "x" } } ), /must be a table/, "table type" );
rejects( () => deserializeProcess( { id: "StarAlignment", params: { targets: [ [ {} ] ] } } ), /must be a table/, "table cell type" );
rejects( () => deserializeProcess( JSON.parse( '{"id":"StarAlignment","params":{"__proto__":{"x":1}}}' ) ), /unknown parameter/, "__proto__" );
rejects( () => deserializeProcess( { id: "StarAlignment", params: { constructor: 1 } } ), /unknown parameter/, "constructor" );
rejects( () => deserializeProcess( { id: "hasOwnProperty" } ), /not allowed/, "inherited name as id" );
rejects( () => deserializeProcess( null ), /no process description/, "missing process" );
rejects( () => serializeProcess( { processId: () => "ExternalProcess" } ), /not distributable/, "server side allowlist" );

// job checks
rejects( () => rebuildJobProcess( { op: "shell", process: data } ), /unknown operation/, "unknown op" );
rejects( () => rebuildJobProcess( { op: "calibration", process: data } ), /expected ImageCalibration/, "op/process mismatch" );
assert.strictEqual( rebuildJobProcess( { op: "registration", process: data } ).process.mode, 3 ); ++passed;
for ( const bad of [ "../x.xisf", "a/b.xisf", "a\\b.xisf", "C:x.xisf", "..", "" ] )
   rejects( () => checkJobFiles( { input_names: [ bad ] } ), /invalid file name/, "file name " + JSON.stringify( bad ) );
rejects( () => checkJobFiles( { input_names: [ "a.xisf" ], file_ref_fields: { masterBiasPath: "../../bias.xisf" } } ), /invalid file name/, "file ref" );
checkJobFiles( { input_names: [ "a_c.xisf", "b.fits" ], reference_name: "ref.xisf", file_ref_fields: { referenceImage: "ref.xisf" } } ); ++passed;

console.log( "serializer.test.js: " + passed + " checks passed" );
