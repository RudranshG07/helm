UPDATE payment_attempt pa
   SET bucket = (
     SELECT p2.bucket FROM payment_attempt p2
      WHERE p2.subscription_id = pa.subscription_id
        AND p2.cycle = pa.cycle
        AND p2.status = 'failed'
        AND p2.bucket IS NOT NULL
        AND p2.attempted_at <= pa.attempted_at
      ORDER BY p2.attempted_at DESC
      LIMIT 1
   )
 WHERE pa.status = 'captured'
   AND pa.source = 'executor'
   AND pa.bucket = 'UNKNOWN'
   AND EXISTS (
     SELECT 1 FROM payment_attempt p3
      WHERE p3.subscription_id = pa.subscription_id
        AND p3.cycle = pa.cycle
        AND p3.status = 'failed'
        AND p3.bucket IS NOT NULL
   );
