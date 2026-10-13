/*
 * ProcessSerializer.js — carry a configured PixInsight process from the server to
 * a worker as plain DATA, and rebuild it there from a fixed allowlist.
 *
 * Wire shape: { id: "<ProcessId>", params: { <name>: <value>, ... } }
 *   - value is a number, a boolean, a string, or a table (array of rows, each row
 *     an array of numbers / booleans / strings).
 *
 * Server side, the parameter NAMES come from the instance's own toSource() listing
 * (the same flags WBPP uses internally); the VALUES are read from the live
 * instance, so nothing is ever parsed back as code. Worker side, the instance is
 * built with `new <Process>` from WBPP_PROCESS_ALLOWLIST, and only parameters
 * that a default instance of that process exposes are assigned, with a type check
 * against the default value. Anything else rejects the whole job.
 */

#ifndef __WBPP_ProcessSerializer_js
#define __WBPP_ProcessSerializer_js

// The processes a worker may be asked to run. Constructors are resolved at call
// time, never at include time.
var WBPP_PROCESS_ALLOWLIST = {
   StarAlignment:      function() { return new StarAlignment; },
   ImageCalibration:   function() { return new ImageCalibration; },
   LocalNormalization: function() { return new LocalNormalization; },
   ImageIntegration:   function() { return new ImageIntegration; },
   DrizzleIntegration: function() { return new DrizzleIntegration; }
};

// Names of the parameters a process instance exposes, from its source listing:
// every `P.<name> = ...` assignment line. Read-only params, time info and
// descriptions are excluded by the flags.
function processParameterNames( processInstance )
{
   var src = processInstance.toSource(
      "JavaScript", "P", 0,
      SourceCodeFlag.NoTimeInfo | SourceCodeFlag.NoReadOnlyParams | SourceCodeFlag.NoDescription );
   var re = /^\s*P\.([A-Za-z_][A-Za-z0-9_]*)\s*=/gm;
   var names = [], seen = {}, m;
   while ( ( m = re.exec( src ) ) !== null )
      if ( !seen[ m[ 1 ] ] )
      {
         seen[ m[ 1 ] ] = true;
         names.push( m[ 1 ] );
      }
   return names;
}

function __wbppIsScalar( v )
{
   var t = typeof v;
   return t == "number" || t == "boolean" || t == "string";
}

// A plain copy of a parameter value: scalars as is, tables as arrays of arrays
// of scalars. Returns undefined for anything else.
function __wbppPlainValue( v )
{
   if ( __wbppIsScalar( v ) )
      return v;
   if ( v == null || typeof v.length != "number" )
      return undefined;
   var rows = [];
   for ( var i = 0; i < v.length; ++i )
   {
      var r = v[ i ];
      if ( r == null || typeof r.length != "number" )
         return undefined;
      var row = [];
      for ( var j = 0; j < r.length; ++j )
      {
         if ( !__wbppIsScalar( r[ j ] ) )
            return undefined;
         row.push( r[ j ] );
      }
      rows.push( row );
   }
   return rows;
}

/*
 * serializeProcess( processInstance ) -> { id, params }. Server side.
 * Throws if the process is not in the allowlist (the worker would refuse it).
 */
function serializeProcess( processInstance )
{
   var id = String( processInstance.processId() );
   if ( !WBPP_PROCESS_ALLOWLIST.hasOwnProperty( id ) )
      throw new Error( "process " + id + " is not distributable" );
   var names = processParameterNames( processInstance );
   var params = {};
   for ( var i = 0; i < names.length; ++i )
   {
      var v = __wbppPlainValue( processInstance[ names[ i ] ] );
      if ( v !== undefined )
         params[ names[ i ] ] = v;
   }
   return { id: id, params: params };
}

/*
 * deserializeProcess( data, expectedId ) -> { process, known }. Worker side.
 *
 * Rejects (throws) when:
 *   - data.id is not in the allowlist, or differs from expectedId (the id the
 *     job's operation requires);
 *   - a parameter name is not exposed by a default instance of that process;
 *   - a value's type differs from the default value's type (scalar vs table,
 *     number vs string, ...), or a table cell is not a scalar.
 * `known` is the set of the process's parameter names, so the caller can check
 * the other field names a manifest refers to (see processHasParameter).
 */
function deserializeProcess( data, expectedId )
{
   if ( data == null || typeof data != "object" )
      throw new Error( "rejected job: no process description" );
   var id = String( data.id );
   if ( !WBPP_PROCESS_ALLOWLIST.hasOwnProperty( id ) )
      throw new Error( "rejected job: process '" + id + "' is not allowed" );
   if ( expectedId && id != expectedId )
      throw new Error( "rejected job: expected " + expectedId + ", got " + id );

   var P = WBPP_PROCESS_ALLOWLIST[ id ]();
   var known = {};
   var names = processParameterNames( P );
   for ( var i = 0; i < names.length; ++i )
      known[ names[ i ] ] = true;

   var params = data.params || {};
   for ( var name in params )
   {
      if ( !params.hasOwnProperty( name ) )
         continue;
      if ( !known.hasOwnProperty( name ) )
         throw new Error( "rejected job: unknown parameter " + id + "." + name );
      var v = params[ name ];
      var def = P[ name ];
      var defIsTable = !__wbppIsScalar( def );
      if ( defIsTable )
      {
         if ( __wbppPlainValue( v ) === undefined || __wbppIsScalar( v ) )
            throw new Error( "rejected job: " + id + "." + name + " must be a table" );
      }
      else if ( typeof v != typeof def )
         throw new Error( "rejected job: " + id + "." + name + " must be a " + ( typeof def ) );
      P[ name ] = v;
   }
   return { process: P, known: known };
}

// True if name is a parameter of a process rebuilt by deserializeProcess.
function processHasParameter( rebuilt, name )
{
   return typeof name == "string" && rebuilt.known.hasOwnProperty( name ) && rebuilt.known[ name ] === true;
}

#endif // __WBPP_ProcessSerializer_js
