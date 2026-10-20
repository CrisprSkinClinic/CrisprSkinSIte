export {};
declare global {
 interface Window {
  CrisprMarketing?: {
   source(): {channel:string;campaign_id:string|null;evidence:string};
   event(name:'booking_started'|'booking_verified'|'booking_completed'|'booking_failed'|'booking_rescheduled'):void;
  };
 }
}
