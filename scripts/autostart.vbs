' LLMSwapper - lanzador oculto para la tarea programada de Windows.
'
' Task Scheduler no puede ocultar la consola de un programa de consola: si la tarea
' ejecutara node.exe a pelo, cada inicio de sesion abriria una ventana negra. Este
' script la lanza con el parametro 0 (oculta) y no espera (False), asi la tarea
' termina en el acto y el servidor se queda corriendo detras.
'
' NO_OPEN=1: al arrancar con la sesion no queremos que abra el navegador. La salida va a
' data\server.log (data/ esta en .gitignore) para poder ver por que no arranco, si pasa.
' Si el puerto ya esta ocupado el servidor lo dice y sale limpio; no hace nada raro.
'
' Se instala con:  scripts\install-autostart.ps1

Option Explicit
Dim shell, fso, root, nodeExe, cmd
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' La raiz del repo es la carpeta padre de scripts\.
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
' La ruta de node la fija el instalador en el primer argumento, porque el PATH que ve una
' tarea al iniciar sesion puede no incluir nvm/volta/fnm.
If WScript.Arguments.Count > 0 Then
  nodeExe = WScript.Arguments(0)
Else
  nodeExe = "node"
End If

shell.CurrentDirectory = root
cmd = "cmd.exe /c set NO_OPEN=1&& """ & nodeExe & """ server.js > ""data\server.log"" 2>&1"
shell.Run cmd, 0, False
