# Minimal right required by the dedicated non-admin Task Scheduler identity.
function Enable-ViewerBatchLogon {
  param([Parameter(Mandatory=$true)][string]$Sid)
  if (-not ('UroDailyPickBatchLogon' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
public static class UroDailyPickBatchLogon {
  [StructLayout(LayoutKind.Sequential)] struct Attributes {
    public uint Length; public IntPtr Root,Name; public uint Flags; public IntPtr Descriptor,Qos;
  }
  [StructLayout(LayoutKind.Sequential)] struct LsaString {
    public ushort Length,MaximumLength; public IntPtr Buffer;
  }
  [DllImport("advapi32.dll")] static extern uint LsaOpenPolicy(IntPtr system,ref Attributes attributes,uint access,out IntPtr policy);
  [DllImport("advapi32.dll")] static extern uint LsaEnumerateAccountRights(IntPtr policy,byte[] sid,out IntPtr rights,out uint count);
  [DllImport("advapi32.dll")] static extern uint LsaAddAccountRights(IntPtr policy,byte[] sid,ref LsaString right,uint count);
  [DllImport("advapi32.dll")] static extern uint LsaNtStatusToWinError(uint status);
  [DllImport("advapi32.dll")] static extern uint LsaFreeMemory(IntPtr memory);
  [DllImport("advapi32.dll")] static extern uint LsaClose(IntPtr policy);
  static void Check(uint status) { if(status!=0) throw new Win32Exception((int)LsaNtStatusToWinError(status)); }
  static byte[] Binary(string sid) {
    var identity=new SecurityIdentifier(sid); var bytes=new byte[identity.BinaryLength]; identity.GetBinaryForm(bytes,0); return bytes;
  }
  static bool Has(IntPtr policy,byte[] sid,string name) {
    IntPtr buffer; uint count; uint status=LsaEnumerateAccountRights(policy,sid,out buffer,out count);
    if(status==0xc0000034) return false;
    Check(status);
    try {
      for(int i=0;i<count;i++) {
        var right=(LsaString)Marshal.PtrToStructure(IntPtr.Add(buffer,i*Marshal.SizeOf(typeof(LsaString))),typeof(LsaString));
        if(Marshal.PtrToStringUni(right.Buffer,right.Length/2)==name) return true;
      }
      return false;
    } finally { LsaFreeMemory(buffer); }
  }
  public static bool Ensure(string sid) {
    var account=(NTAccount)new SecurityIdentifier(sid).Translate(typeof(NTAccount));
    if(!account.Value.Equals(Environment.MachineName+"\\UroDailyPickReader",StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Unexpected viewer account");
    var attributes=new Attributes(); attributes.Length=(uint)Marshal.SizeOf(typeof(Attributes));
    IntPtr policy; Check(LsaOpenPolicy(IntPtr.Zero,ref attributes,0x810,out policy));
    try {
      byte[] bytes=Binary(sid);
      foreach(string identity in new string[]{sid,"S-1-1-0","S-1-5-11","S-1-5-113","S-1-5-32-545"})
        if(Has(policy,Binary(identity),"SeDenyBatchLogonRight")) throw new InvalidOperationException("Existing batch-logon deny policy; it was not changed");
      if(Has(policy,bytes,"SeBatchLogonRight")) return false;
      string name="SeBatchLogonRight";
      var right=new LsaString(); right.Length=(ushort)(name.Length*2); right.MaximumLength=(ushort)(right.Length+2); right.Buffer=Marshal.StringToHGlobalUni(name);
      try { Check(LsaAddAccountRights(policy,bytes,ref right,1)); } finally { Marshal.FreeHGlobal(right.Buffer); }
      if(!Has(policy,bytes,name)) throw new InvalidOperationException("Batch-logon right verification failed");
      return true;
    } finally { LsaClose(policy); }
  }
}
'@
  }
  [UroDailyPickBatchLogon]::Ensure($Sid)
}
