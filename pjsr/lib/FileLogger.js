/*
 * FileLogger.js — append-style log to a file, safe and simple.
 *
 * PJSR has no reliable append primitive across versions, so we keep the full log
 * in memory and rewrite the file on every line. Sessions are short (hundreds of
 * lines), so the cost is negligible, and the file is always complete/current —
 * which lets it be tailed live from another machine over the shared drive.
 */

#ifndef __WBPP_FileLogger_js
#define __WBPP_FileLogger_js

function __wbpp_pad2( n ) { return ( n < 10 ? "0" : "" ) + n; }

// "HH:MM:SS" for line timestamps.
function wbppNowHMS()
{
   var d = new Date;
   return __wbpp_pad2( d.getHours() ) + ":" + __wbpp_pad2( d.getMinutes() ) + ":" + __wbpp_pad2( d.getSeconds() );
}

// "YYYYMMDD-HHMMSS-mmm" for unique filenames.
function wbppStamp()
{
   var d = new Date;
   var ms = d.getMilliseconds();
   return "" + d.getFullYear() + __wbpp_pad2( d.getMonth() + 1 ) + __wbpp_pad2( d.getDate() ) +
      "-" + __wbpp_pad2( d.getHours() ) + __wbpp_pad2( d.getMinutes() ) + __wbpp_pad2( d.getSeconds() ) +
      "-" + ( ms < 100 ? ( ms < 10 ? "00" : "0" ) : "" ) + ms;
}

/*
 * FileLogger( dir, prefix, header )
 *   dir    : directory to write into (created if missing)
 *   prefix : filename prefix, e.g. "server" or "client"
 *   header : optional first lines (array of strings)
 * The final path is <dir>/<prefix>-<stamp>.log and is exposed as .path.
 */
function FileLogger( dir, prefix, header )
{
   this.ok = false;
   this.buffer = "";
   try
   {
      if ( !File.directoryExists( dir ) )
         File.createDirectory( dir, true );
      this.path = dir + "/" + prefix + "-" + wbppStamp() + ".log";
      if ( header && header.length )
         for ( var i = 0; i < header.length; ++i )
            this.buffer += header[ i ] + "\n";
      File.writeTextFile( this.path, this.buffer );
      this.ok = true;
   }
   catch ( e )
   {
      this.path = "";
   }

   // Append a timestamped line and flush to disk. Never throws.
   this.line = function( msg )
   {
      if ( !this.ok )
         return;
      this.buffer += wbppNowHMS() + "  " + msg + "\n";
      try { File.writeTextFile( this.path, this.buffer ); } catch ( e ) { this.ok = false; }
   };
}

#endif // __WBPP_FileLogger_js
