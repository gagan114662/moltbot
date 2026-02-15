import type { Mesh } from "three";
import { OrbitControls, Stars } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { useRef } from "react";

/**
 * A 3D solar system scene — Jupiter and the Great Red Spot.
 *
 * "See that red spot? That storm has been raging for 400 years.
 *  It's bigger than Earth. Want to get closer?"
 */

function Jupiter() {
  const ref = useRef<Mesh>(null!);

  useFrame((_, delta) => {
    ref.current.rotation.y += delta * 0.15;
  });

  return (
    <mesh ref={ref} position={[0, 0, 0]}>
      <sphereGeometry args={[2.5, 64, 64]} />
      <meshStandardMaterial color="#c4956a" roughness={0.8} metalness={0.1} />
      {/* Great Red Spot — simplified as a darker region */}
      <mesh position={[1.8, 0.3, 1.5]}>
        <sphereGeometry args={[0.5, 32, 32]} />
        <meshStandardMaterial color="#a0522d" roughness={0.9} metalness={0} />
      </mesh>
    </mesh>
  );
}

function JupiterBands() {
  // Atmospheric bands as thin torus rings
  return (
    <>
      {[-0.8, -0.3, 0.2, 0.7, 1.2].map((y, i) => (
        <mesh key={i} position={[0, y, 0]} rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[2.51, 0.02, 8, 64]} />
          <meshStandardMaterial
            color={i % 2 === 0 ? "#b8845a" : "#d4a574"}
            transparent
            opacity={0.4}
          />
        </mesh>
      ))}
    </>
  );
}

function Moon({ distance, speed, size }: { distance: number; speed: number; size: number }) {
  const ref = useRef<Mesh>(null!);
  const angle = useRef(Math.random() * Math.PI * 2);

  useFrame((_, delta) => {
    angle.current += delta * speed;
    ref.current.position.x = Math.cos(angle.current) * distance;
    ref.current.position.z = Math.sin(angle.current) * distance;
  });

  return (
    <mesh ref={ref}>
      <sphereGeometry args={[size, 16, 16]} />
      <meshStandardMaterial color="#a0a0a0" roughness={0.9} />
    </mesh>
  );
}

export function SolarSystem() {
  return (
    <Canvas
      camera={{ position: [0, 2, 8], fov: 50 }}
      style={{ width: "100%", height: "100%", background: "#0a0a0a" }}
    >
      {/* Lighting */}
      <ambientLight intensity={0.15} />
      <directionalLight position={[10, 5, 5]} intensity={1.2} color="#fff5e6" />
      <pointLight position={[-5, -3, -5]} intensity={0.3} color="#4a90d9" />

      {/* Stars */}
      <Stars radius={100} depth={50} count={3000} factor={4} fade speed={0.5} />

      {/* Jupiter */}
      <Jupiter />
      <JupiterBands />

      {/* Moons */}
      <Moon distance={4} speed={0.5} size={0.15} />
      <Moon distance={5} speed={0.3} size={0.2} />
      <Moon distance={6.5} speed={0.2} size={0.12} />

      {/* Orbit controls — let the student look around */}
      <OrbitControls
        enablePan={false}
        enableZoom={true}
        minDistance={4}
        maxDistance={20}
        autoRotate
        autoRotateSpeed={0.3}
      />
    </Canvas>
  );
}
