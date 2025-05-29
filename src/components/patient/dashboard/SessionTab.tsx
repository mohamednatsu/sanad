import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import { useLanguage } from "@/hooks/useLanguage";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/use-toast";
import { Video, VideoOff, Mic, MicOff, Phone } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { format } from "date-fns";

interface TherapistVideoSessionProps {
  isVisible: boolean;
}

interface AppointmentSession {
  id: string;
  doctor_id: string;
  patient_id: string;
  patient_name: string;
  session_date: string;
  session_type: string;
  status: string;
}

const TherapistVideoSession = ({ isVisible }: TherapistVideoSessionProps) => {
  const { user } = useAuth();
  const { t } = useLanguage();
  const { toast } = useToast();

  // Video call state
  const [isSessionActive, setIsSessionActive] = useState(false);
  const [isVideoEnabled, setIsVideoEnabled] = useState(true);
  const [isAudioEnabled, setIsAudioEnabled] = useState(true);
  const [isConnecting, setIsConnecting] = useState(false);
  const [upcomingSession, setUpcomingSession] = useState<AppointmentSession | null>(null);
  const [isTestMode, setIsTestMode] = useState(false);
  const [hasCameraPermission, setHasCameraPermission] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);

  // Refs for video elements
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);

  // WebRTC states
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);

  // Check camera permissions
  const checkCameraPermissions = async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoDevices = devices.filter(device => device.kind === 'videoinput');
      const hasPermission = videoDevices.some(device => device.label !== '');
      setHasCameraPermission(hasPermission);
      return hasPermission;
    } catch (error) {
      console.error("Error checking camera permissions:", error);
      setHasCameraPermission(false);
      return false;
    }
  };

  // Fetch upcoming session
  useEffect(() => {
    const fetchUpcomingSession = async () => {
      if (!user) return;

      try {
        const now = new Date();
        const { data, error } = await supabase
          .from('appointments')
          .select('*')
          .eq('doctor_id', user.id)
          .eq('status', 'scheduled')
          .gte('session_date', now.toISOString())
          .order('session_date', { ascending: true })
          .limit(1)
          .single();

        if (error && error.code !== 'PGRST116') {
          console.error("Error fetching upcoming session:", error);
        }

        if (data) {
          console.log(data);
          setUpcomingSession({
            ...data,
            patient_name: "Unknown Patient"
          } as AppointmentSession);
        }
      } catch (error) {
        console.error("Error fetching upcoming session:", error);
      }
    };

    fetchUpcomingSession();
    checkCameraPermissions();
  }, [user]);

  // Initialize WebRTC
  const initializeWebRTC = async (testMode = false) => {
    try {
      setIsConnecting(true);
      setIsTestMode(testMode);
      setCameraError(null);
      setIsSessionActive(true);  // Render video elements immediately

      // First check if we have permission
      const hasPermission = await checkCameraPermissions();
      if (!hasPermission) {
        throw new Error("Camera permission denied");
      }

      // Get media stream with better error handling
      const stream = await navigator.mediaDevices.getUserMedia({
        video: isVideoEnabled ? {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          facingMode: "user"
        } : false,
        audio: isAudioEnabled
      }).catch(err => {
        console.error("Error accessing media devices:", err);
        throw err;
      });

      localStreamRef.current = stream;

      // Attach to local video after component re-render
      setTimeout(() => {
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
          localVideoRef.current.play()
            .catch(e => console.error("Error playing local video:", e));
        }
      }, 100);

      // In test mode, display same stream in both videos
      if (testMode) {
        setTimeout(() => {
          if (remoteVideoRef.current) {
            remoteVideoRef.current.srcObject = stream;
            remoteVideoRef.current.play()
              .catch(e => console.error("Error playing remote test video:", e));
          }
        }, 100);
        setIsConnecting(false);
        toast({
          title: t('test_session_started'),
          description: t('you_can_test_your_video_and_audio'),
        });
        return;
      }

      // Create peer connection for real sessions
      const configuration = {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' }
        ]
      };

      peerConnectionRef.current = new RTCPeerConnection(configuration);

      // Add tracks to peer connection
      stream.getTracks().forEach(track => {
        if (peerConnectionRef.current) {
          peerConnectionRef.current.addTrack(track, stream);
        }
      });

      // Handle remote tracks
      peerConnectionRef.current.ontrack = (event) => {
        if (remoteVideoRef.current && event.streams && event.streams[0]) {
          remoteVideoRef.current.srcObject = event.streams[0];
          remoteVideoRef.current.onloadedmetadata = () => {
            remoteVideoRef.current?.play().catch(e => console.error("Error playing remote video:", e));
          };
        }
      };

      setIsConnecting(false);

      toast({
        title: t('session_joined'),
        description: upcomingSession ?
          `${t('session_with')} ${upcomingSession.patient_name}` :
          t('session_active'),
      });
    } catch (error) {
      console.error("Error initializing WebRTC:", error);
      setIsConnecting(false);
      setIsSessionActive(false); // Hide video elements on error

      let errorMessage = t('please_check_camera_microphone_permissions');
      if (error instanceof Error) {
        if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
          errorMessage = t('no_camera_or_microphone_found');
        } else if (error.name === 'NotReadableError' || error.name === 'TrackStartError') {
          errorMessage = t('camera_or_microphone_in_use');
        } else if (error.name === 'OverconstrainedError' || error.name === 'ConstraintNotSatisfiedError') {
          errorMessage = t('requested_settings_not_supported');
        } else if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
          errorMessage = t('permission_denied_please_enable_camera_microphone');
          setCameraError(errorMessage);
        }
      }

      toast({
        title: t('error_starting_session'),
        description: errorMessage,
        variant: "destructive",
      });
    }
  };

  // Toggle video
  const toggleVideo = () => {
    if (localStreamRef.current) {
      const videoTracks = localStreamRef.current.getVideoTracks();

      // If enabling video but no active tracks, request new stream
      if (!isVideoEnabled && videoTracks.length === 0) {
        navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
          audio: isAudioEnabled
        }).then(stream => {
          localStreamRef.current = stream;
          if (localVideoRef.current) {
            localVideoRef.current.srcObject = stream;
          }
          setIsVideoEnabled(true);
        }).catch(console.error);
        return;
      }

      // Toggle existing tracks
      videoTracks.forEach(track => {
        track.enabled = !isVideoEnabled;
      });
      setIsVideoEnabled(!isVideoEnabled);

      toast({
        title: !isVideoEnabled ? t('video_enabled') : t('video_disabled'),
        description: !isVideoEnabled ? '' : t('audio_only_mode'),
      });
    }
  };

  // Toggle audio
  const toggleAudio = () => {
    if (localStreamRef.current) {
      const audioTracks = localStreamRef.current.getAudioTracks();
      audioTracks.forEach(track => {
        track.enabled = !isAudioEnabled;
      });
      setIsAudioEnabled(!isAudioEnabled);
    }
  };

  // End session
  const endSession = () => {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => track.stop());
      localStreamRef.current = null;
    }

    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }

    // Clear video elements
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = null;
    }
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null;
    }

    setIsSessionActive(false);
    setIsTestMode(false);
    setIsVideoEnabled(true);
    setIsAudioEnabled(true);

    toast({
      title: isTestMode ? t('test_session_ended') : t('session_ended'),
      description: isTestMode ? '' : t('session_summary_email'),
    });
  };

  // Handle visibility changes
  useEffect(() => {
    if (!isVisible && isSessionActive) {
      // When component becomes invisible, pause all tracks
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach(track => track.enabled = false);
      }
    } else if (isVisible && isSessionActive) {
      // When component becomes visible again, resume tracks
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach(track => {
          if (track.kind === 'video') {
            track.enabled = isVideoEnabled;
          } else if (track.kind === 'audio') {
            track.enabled = isAudioEnabled;
          }
        });
      }
    }
  }, [isVisible]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      endSession(); // Clean up everything when component unmounts
    };
  }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('video_session')}</CardTitle>
        <CardDescription>{t('manage_your_therapy_sessions')}</CardDescription>
      </CardHeader>

      <CardContent className="space-y-6">
        {cameraError && (
          <div className="p-4 bg-red-100 text-red-800 rounded-lg mb-4">
            <p>{cameraError}</p>
            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => {
                window.location.reload(); // Sometimes needed to trigger permission dialog
              }}
            >
              {t('retry')}
            </Button>
          </div>
        )}

        {!hasCameraPermission && !cameraError && (
          <div className="p-4 bg-yellow-100 text-yellow-800 rounded-lg mb-4">
            <p>{t('camera_permission_required')}</p>
            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={checkCameraPermissions}
            >
              {t('check_permissions')}
            </Button>
          </div>
        )}

        {isSessionActive ? (
          <div className="space-y-4">
            <div className="relative">
              <div className="w-full aspect-video bg-black rounded-lg overflow-hidden">
                {/* Remote video (patient or test video) */}
                <video
                  ref={remoteVideoRef}
                  className="w-full h-full object-cover"
                  autoPlay
                  playsInline
                ></video>

                {/* Connecting overlay */}
                {isConnecting && (
                  <div className="absolute inset-0 bg-black bg-opacity-50 flex items-center justify-center rounded-lg">
                    <div className="flex flex-col items-center">
                      <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-primary mb-4"></div>
                      <p className="text-white">{t('connecting')}</p>
                    </div>
                  </div>
                )}
              </div>

              {/* Local video (therapist) */}
              <div className="absolute bottom-4 right-4 w-1/4 aspect-video bg-gray-800 rounded-lg overflow-hidden shadow-lg border-2 border-white">
                <video
                  ref={localVideoRef}
                  className="w-full h-full object-cover"
                  autoPlay
                  playsInline
                  muted
                ></video>
              </div>
            </div>

            <div className="flex justify-center gap-4">
              <Button
                variant={isVideoEnabled ? "default" : "outline"}
                onClick={toggleVideo}
                className="rounded-full p-3 h-12 w-12"
              >
                {isVideoEnabled ? <Video size={18} /> : <VideoOff size={18} />}
              </Button>

              <Button
                variant={isAudioEnabled ? "default" : "outline"}
                onClick={toggleAudio}
                className="rounded-full p-3 h-12 w-12"
              >
                {isAudioEnabled ? <Mic size={18} /> : <MicOff size={18} />}
              </Button>

              <Button
                variant="destructive"
                onClick={endSession}
                className="rounded-full p-3 h-12 w-12"
              >
                <Phone size={18} className="rotate-135" />
              </Button>
            </div>

            <div className="text-center text-sm text-muted-foreground">
              {isTestMode ? (
                <p>{t('test_session_active')}</p>
              ) : upcomingSession ? (
                <p>{t('session_with')} <strong>{upcomingSession.patient_name}</strong></p>
              ) : (
                <p>{t('live_session')}</p>
              )}
            </div>
          </div>
        ) : isConnecting ? (
          <div className="flex flex-col items-center justify-center py-12">
            <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-primary mb-4"></div>
            <p>{t('connecting')}</p>
            {!hasCameraPermission && (
              <p className="text-sm text-muted-foreground mt-2">
                {t('checking_camera_permissions')}
              </p>
            )}
          </div>
        ) : upcomingSession ? (
          <div className="space-y-6 py-6">
            <div className="text-center space-y-2">
              <h3 className="text-xl font-medium">{t('upcoming_session')}</h3>
              <p className="text-primary text-2xl font-semibold">
                {upcomingSession.patient_name}
              </p>
              <p>
                {format(new Date(upcomingSession.session_date), 'PPP')} {t('at')} {format(new Date(upcomingSession.session_date), 'p')}
              </p>
              <p className="text-sm text-muted-foreground">
                {upcomingSession.session_type}
              </p>
            </div>

            <div className="flex justify-center gap-4">
              <Button
                onClick={() => initializeWebRTC(false)}
                disabled={!hasCameraPermission}
              >
                {t('join_session')}
              </Button>
              <Button
                variant="outline"
                onClick={() => initializeWebRTC(true)}
                disabled={!hasCameraPermission}
              >
                {t('test_video_audio')}
              </Button>
            </div>

            <div className="border rounded-lg p-4 space-y-4 bg-muted/30">
              <h4 className="font-medium">{t('session_tips')}</h4>
              <div className="space-y-2">
                <p className="text-sm font-medium">{t('quiet_environment')}</p>
                <p className="text-xs text-muted-foreground">{t('find_quiet_space_tip')}</p>
              </div>
              <div className="space-y-2">
                <p className="text-sm font-medium">{t('test_equipment')}</p>
                <p className="text-xs text-muted-foreground">{t('test_equipment_tip')}</p>
              </div>
              <div className="space-y-2">
                <p className="text-sm font-medium">{t('be_prepared')}</p>
                <p className="text-xs text-muted-foreground">{t('be_prepared_tip')}</p>
              </div>
            </div>
          </div>
        ) : (
          <div className="text-center py-12 space-y-4">
            <h3 className="text-xl font-medium mb-2">{t('no_scheduled_session')}</h3>
            <p className="text-muted-foreground mb-6">{t('please_schedule_session_first')}</p>
            <Button
              variant="outline"
              onClick={() => initializeWebRTC(true)}
              disabled={!hasCameraPermission}
            >
              {t('test_video_audio')}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
};

export default TherapistVideoSession;
